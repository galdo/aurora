package app.pulse.laucher.dlna

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import app.pulse.laucher.R
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.UUID
import java.util.Collections
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONArray
import org.json.JSONObject

class PulseMediaRendererService : Service() {
    companion object {
        @Volatile
        var instance: PulseMediaRendererService? = null
    }

    private val channelId = "pulse-dlna-renderer"
    private val notificationId = 1532
    private val running = AtomicBoolean(false)
    private val serviceUuid = "uuid:${UUID.nameUUIDFromBytes("PulseAudioRenderer".toByteArray())}"
    private val serverName = "PulseLauncher/1.0 UPnP/1.1 AuroraPulseDLNA/1.0"
    private var multicastLock: WifiManager.MulticastLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var httpServerSocket: ServerSocket? = null
    private var httpPort: Int = 0
    private var httpThread: Thread? = null
    private var ssdpThread: Thread? = null
    private var announceThread: Thread? = null
    @Volatile private var networkConnectionLostNotified: Boolean = false
    @Volatile private var transportState: String = "STOPPED"
    @Volatile private var currentTrackUri: String = ""
    @Volatile private var nextTrackUri: String = ""
    @Volatile private var currentTrackTitle: String = "DLNA Stream"
    @Volatile private var currentTrackArtist: String = "External"
    @Volatile private var currentTrackAlbumArt: String = ""
    @Volatile private var volume: Int = 45
    @Volatile private var muted: Boolean = false
    @Volatile private var currentPositionMs: Long = 0
    @Volatile private var currentDurationMs: Long = 0
    @Volatile private var queueCurrentIndex: Int = 0
    @Volatile private var queueTotalTracks: Int = 1
    @Volatile private var queueContextId: String = ""
    private val queueTracks: MutableList<JSONObject> = mutableListOf()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        acquireMulticastLock()
        acquireWifiLock()
        startForeground(notificationId, createForegroundNotification())
        startServers()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!running.get()) {
            startServers()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running.set(false)
        runCatching { httpServerSocket?.close() }
        runCatching { multicastLock?.release() }
        runCatching { wifiLock?.release() }
        multicastLock = null
        wifiLock = null
        instance = null
        super.onDestroy()
    }

    private fun startServers() {
        if (running.getAndSet(true)) {
            return
        }
        startHttpServer()
        startSsdpResponder()
        startAnnouncer()
    }

    private fun startHttpServer() {
        httpThread = Thread {
            runCatching {
                httpServerSocket = ServerSocket(0)
                httpPort = httpServerSocket!!.localPort
                while (running.get()) {
                    val client = httpServerSocket?.accept() ?: break
                    handleHttpClient(client)
                }
            }.onFailure {
                Log.e("PulseDLNA", "HTTP server failed", it)
            }
        }.apply { start() }
    }

    private fun startSsdpResponder() {
        ssdpThread = Thread {
            var socket: MulticastSocket? = null
            runCatching {
                val group = InetAddress.getByName("239.255.255.250")
                socket = MulticastSocket(null).apply {
                    reuseAddress = true
                    soTimeout = 2000
                    bind(InetSocketAddress(1900))
                }
                val joinedInterfaces = mutableListOf<NetworkInterface>()
                Collections.list(NetworkInterface.getNetworkInterfaces() ?: return@runCatching).forEach { networkInterface ->
                    if (!networkInterface.isUp || networkInterface.isLoopback || !networkInterface.supportsMulticast()) {
                        return@forEach
                    }
                    runCatching {
                        socket!!.joinGroup(InetSocketAddress(group, 1900), networkInterface)
                        joinedInterfaces.add(networkInterface)
                    }
                }
                val buffer = ByteArray(4096)
                while (running.get()) {
                    val packet = DatagramPacket(buffer, buffer.size)
                    try {
                        socket!!.receive(packet)
                    } catch (_error: Exception) {
                        continue
                    }
                    val message = String(packet.data, 0, packet.length, StandardCharsets.UTF_8)
                    if (!message.contains("M-SEARCH", ignoreCase = true)) continue
                    val st = message.lineSequence()
                        .firstOrNull { it.uppercase(Locale.US).startsWith("ST:") }
                        ?.substringAfter(":")
                        ?.trim()
                        ?.lowercase(Locale.US)
                        ?: "ssdp:all"
                    respondToSearch(packet.address, packet.port, st)
                }
                joinedInterfaces.forEach { networkInterface ->
                    runCatching {
                        socket?.leaveGroup(InetSocketAddress(group, 1900), networkInterface)
                    }
                }
            }.onFailure {
                Log.e("PulseDLNA", "SSDP responder failed", it)
                notifyConnectionLostIfNeeded("ssdp_failed")
            }
            runCatching { socket?.close() }
        }.apply { start() }
    }

    private fun startAnnouncer() {
        announceThread = Thread {
            while (running.get()) {
                val location = getLocationUrl()
                if (location.isBlank()) {
                    notifyConnectionLostIfNeeded("no_location")
                    Thread.sleep(5000)
                    continue
                }
                networkConnectionLostNotified = false
                sendAliveNotify("upnp:rootdevice", "$serviceUuid::upnp:rootdevice")
                sendAliveNotify("urn:schemas-upnp-org:device:MediaRenderer:1", "$serviceUuid::urn:schemas-upnp-org:device:MediaRenderer:1")
                sendAliveNotify("urn:schemas-upnp-org:service:AVTransport:1", "$serviceUuid::urn:schemas-upnp-org:service:AVTransport:1")
                sendAliveNotify("urn:schemas-upnp-org:service:RenderingControl:1", "$serviceUuid::urn:schemas-upnp-org:service:RenderingControl:1")
                sendAliveNotify("urn:schemas-upnp-org:service:ConnectionManager:1", "$serviceUuid::urn:schemas-upnp-org:service:ConnectionManager:1")
                Thread.sleep(15000)
            }
        }.apply { start() }
    }

    private fun notifyConnectionLostIfNeeded(reason: String) {
        if (networkConnectionLostNotified) {
            return
        }
        networkConnectionLostNotified = true
        PulseDLNAControlBridge.emit("DLNA_CONNECTION_LOST", mapOf("reason" to reason))
    }

    private fun sendAliveNotify(nt: String, usn: String) {
        val location = getLocationUrl()
        if (location.isBlank()) return
        val message = """
            NOTIFY * HTTP/1.1
            HOST: 239.255.255.250:1900
            CACHE-CONTROL: max-age=120
            LOCATION: $location
            NT: $nt
            NTS: ssdp:alive
            SERVER: $serverName
            USN: $usn
            
            
        """.trimIndent().replace("\n", "\r\n").toByteArray(StandardCharsets.UTF_8)
        runCatching {
            MulticastSocket().use { socket ->
                socket.send(DatagramPacket(message, message.size, InetAddress.getByName("239.255.255.250"), 1900))
            }
        }
    }

    private fun respondToSearch(address: InetAddress, port: Int, st: String) {
        val location = getLocationUrl()
        if (location.isBlank()) return
        val headers = mutableListOf<String>()
        fun addResponse(respSt: String, usn: String) {
            val response = """
                HTTP/1.1 200 OK
                CACHE-CONTROL: max-age=120
                DATE: ${java.util.Date()}
                EXT:
                LOCATION: $location
                SERVER: $serverName
                ST: $respSt
                USN: $usn
                
                
            """.trimIndent().replace("\n", "\r\n")
            headers.add(response)
        }
        val wantsAll = st == "ssdp:all"
        if (wantsAll || st == "upnp:rootdevice") addResponse("upnp:rootdevice", "$serviceUuid::upnp:rootdevice")
        if (wantsAll || st == serviceUuid.lowercase(Locale.US)) addResponse(serviceUuid, serviceUuid)
        if (wantsAll || st.contains("mediarenderer")) addResponse("urn:schemas-upnp-org:device:MediaRenderer:1", "$serviceUuid::urn:schemas-upnp-org:device:MediaRenderer:1")
        if (wantsAll || st.contains("avtransport")) addResponse("urn:schemas-upnp-org:service:AVTransport:1", "$serviceUuid::urn:schemas-upnp-org:service:AVTransport:1")
        if (wantsAll || st.contains("renderingcontrol")) addResponse("urn:schemas-upnp-org:service:RenderingControl:1", "$serviceUuid::urn:schemas-upnp-org:service:RenderingControl:1")
        if (wantsAll || st.contains("connectionmanager")) addResponse("urn:schemas-upnp-org:service:ConnectionManager:1", "$serviceUuid::urn:schemas-upnp-org:service:ConnectionManager:1")
        DatagramSocket().use { udp ->
            headers.forEach {
                val bytes = it.toByteArray(StandardCharsets.UTF_8)
                udp.send(DatagramPacket(bytes, bytes.size, address, port))
            }
        }
    }

    private fun handleHttpClient(socket: Socket) {
        Thread {
            runCatching {
                socket.use { client ->
                    val input = BufferedReader(InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8))
                    val requestLine = input.readLine() ?: return@use
                    val parts = requestLine.split(" ")
                    if (parts.size < 2) return@use
                    val method = parts[0]
                    val path = parts[1]
                    val headers = mutableMapOf<String, String>()
                    while (true) {
                        val line = input.readLine() ?: break
                        if (line.isBlank()) break
                        val index = line.indexOf(":")
                        if (index > 0) {
                            headers[line.substring(0, index).trim().lowercase(Locale.US)] = line.substring(index + 1).trim()
                        }
                    }
                    val body = if (headers["content-length"]?.toIntOrNull()?.let { it > 0 } == true) {
                        val size = headers["content-length"]!!.toInt()
                        val chars = CharArray(size)
                        input.read(chars, 0, size)
                        String(chars)
                    } else ""
                    val output = client.getOutputStream()
                    when {
                        method == "GET" && path == "/description.xml" -> writeHttp(output, 200, "text/xml; charset=\"utf-8\"", buildDescriptionXml())
                        method == "POST" && path == "/aurora/queue" -> writeHttp(output, 200, "application/json; charset=\"utf-8\"", handleQueueContext(body))
                        method == "POST" && path.contains("/avtransport") -> writeHttp(output, 200, "text/xml; charset=\"utf-8\"", handleAvTransport(headers["soapaction"] ?: "", body))
                        method == "POST" && path.contains("/renderingcontrol") -> writeHttp(output, 200, "text/xml; charset=\"utf-8\"", handleRenderingControl(headers["soapaction"] ?: "", body))
                        method == "POST" && path.contains("/connectionmanager") -> writeHttp(output, 200, "text/xml; charset=\"utf-8\"", handleConnectionManager(headers["soapaction"] ?: "", body))
                        else -> writeHttp(output, 404, "text/plain", "not found")
                    }
                }
            }
        }.start()
    }

    private fun handleAvTransport(actionHeader: String, body: String): String {
        val action = actionHeader.substringAfter("#").substringBefore("\"")
        when (action) {
            "SetAVTransportURI" -> {
                currentTrackUri = extractXmlValue(body, "CurrentURI")
                val meta = parseDidlMeta(extractXmlValue(body, "CurrentURIMetaData"))
                currentTrackTitle = meta["title"] ?: "DLNA Stream"
                currentTrackArtist = meta["artist"] ?: "External"
                currentTrackAlbumArt = absolutizeUri(meta["albumArt"] ?: "", currentTrackUri)
                meta["duration"]?.let { value ->
                    currentDurationMs = parseDurationToMs(value)
                }
                updateQueuePointerByUri(currentTrackUri)
                Log.i(
                    "PulseDLNAQueue",
                    "SetAVTransportURI context=$queueContextId queueSize=${queueTracks.size} index=$queueCurrentIndex uri=$currentTrackUri",
                )
                PulseDLNAControlBridge.emit(
                    "DLNA_SET_URI",
                    mapOf(
                        "uri" to currentTrackUri,
                        "title" to currentTrackTitle,
                        "artist" to currentTrackArtist,
                        "albumArt" to currentTrackAlbumArt,
                    ),
                )
                transportState = "STOPPED"
            }
            "SetNextAVTransportURI" -> {
                nextTrackUri = extractXmlValue(body, "NextURI")
                val nextMeta = parseDidlMeta(extractXmlValue(body, "NextURIMetaData"))
                ensureQueueContainsNextTrack(nextTrackUri, nextMeta)
                Log.i(
                    "PulseDLNAQueue",
                    "SetNextAVTransportURI context=$queueContextId queueSize=${queueTracks.size} index=$queueCurrentIndex next=$nextTrackUri",
                )
                PulseDLNAControlBridge.emit(
                    "DLNA_SET_NEXT_URI",
                    mapOf(
                        "uri" to nextTrackUri,
                        "title" to (nextMeta["title"] ?: ""),
                        "artist" to (nextMeta["artist"] ?: ""),
                        "albumArt" to absolutizeUri(nextMeta["albumArt"] ?: "", nextTrackUri),
                    ),
                )
            }
            "Play" -> {
                transportState = "PLAYING"
                Log.i(
                    "PulseDLNAQueue",
                    "Play context=$queueContextId queueSize=${queueTracks.size} index=$queueCurrentIndex uri=$currentTrackUri",
                )
                PulseDLNAControlBridge.emit("DLNA_PLAY")
            }
            "Pause" -> {
                transportState = "PAUSED_PLAYBACK"
                PulseDLNAControlBridge.emit("DLNA_PAUSE")
            }
            "Stop" -> {
                transportState = "STOPPED"
                PulseDLNAControlBridge.emit("DLNA_STOP")
            }
            "Next" -> {
                if (queueCurrentIndex < (queueTracks.size - 1)) {
                    queueCurrentIndex += 1
                    currentTrackUri = queueTracks[queueCurrentIndex].optString("uri", currentTrackUri)
                } else if (nextTrackUri.isNotBlank()) {
                    currentTrackUri = nextTrackUri
                }
                transportState = "PLAYING"
                PulseDLNAControlBridge.emit("DLNA_NEXT")
                PulseDLNAControlBridge.emit("DLNA_FORWARD")
            }
            "Previous" -> {
                if (queueCurrentIndex > 0 && queueTracks.isNotEmpty()) {
                    queueCurrentIndex -= 1
                    currentTrackUri = queueTracks[queueCurrentIndex].optString("uri", currentTrackUri)
                }
                transportState = "PLAYING"
                PulseDLNAControlBridge.emit("DLNA_PREVIOUS")
                PulseDLNAControlBridge.emit("DLNA_REWIND")
            }
            "Seek" -> {
                transportState = if (transportState == "STOPPED") "PAUSED_PLAYBACK" else transportState
                val target = extractXmlValue(body, "Target")
                if (target.isNotBlank()) {
                    PulseDLNAControlBridge.emit("DLNA_SEEK", mapOf("target" to target))
                }
            }
            "GetTransportInfo" -> return soapResponse("u:GetTransportInfoResponse", "urn:schemas-upnp-org:service:AVTransport:1", "<CurrentTransportState>$transportState</CurrentTransportState><CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>")
            "GetPositionInfo" -> return soapResponse(
                "u:GetPositionInfoResponse",
                "urn:schemas-upnp-org:service:AVTransport:1",
                "<Track>${(queueCurrentIndex + 1).coerceAtLeast(1)}</Track><TrackDuration>${formatMsToHms(currentDurationMs)}</TrackDuration><TrackMetaData>NOT_IMPLEMENTED</TrackMetaData><TrackURI>${escapeXml(currentTrackUri)}</TrackURI><RelTime>${formatMsToHms(currentPositionMs)}</RelTime><AbsTime>${formatMsToHms(currentPositionMs)}</AbsTime><RelCount>0</RelCount><AbsCount>0</AbsCount>",
            )
            "GetMediaInfo" -> return soapResponse(
                "u:GetMediaInfoResponse",
                "urn:schemas-upnp-org:service:AVTransport:1",
                "<NrTracks>${queueTotalTracks.coerceAtLeast(1)}</NrTracks><MediaDuration>${formatMsToHms(currentDurationMs)}</MediaDuration><CurrentURI>${escapeXml(currentTrackUri)}</CurrentURI><CurrentURIMetaData>NOT_IMPLEMENTED</CurrentURIMetaData><NextURI>${escapeXml(nextTrackUri)}</NextURI><NextURIMetaData></NextURIMetaData><PlayMedium>NETWORK</PlayMedium><RecordMedium>NOT_IMPLEMENTED</RecordMedium><WriteStatus>NOT_IMPLEMENTED</WriteStatus>",
            )
        }
        return soapResponse("u:${action}Response", "urn:schemas-upnp-org:service:AVTransport:1", "")
    }

    private fun handleQueueContext(body: String): String {
        return runCatching {
            val root = JSONObject(body)
            val nextContextId = root.optString("contextId", "")
            val tracks = root.optJSONArray("tracks") ?: JSONArray()
            val incomingTrackCount = tracks.length()
            if (incomingTrackCount <= 1 && queueTracks.size > 1) {
                Log.i(
                    "PulseDLNAQueue",
                    "QueueContext ignored hard-lock context=${nextContextId.ifBlank { queueContextId }} incoming=$incomingTrackCount existing=${queueTracks.size}",
                )
                return@runCatching """{"ok":true}"""
            }
            queueContextId = nextContextId
            queueTracks.clear()
            for (index in 0 until tracks.length()) {
                val entry = tracks.optJSONObject(index) ?: continue
                queueTracks.add(entry)
            }
            queueTotalTracks = queueTracks.size.coerceAtLeast(1)
            val currentUri = root.optString("currentUri", "")
            val requestedIndex = queueTracks.indexOfFirst { it.optString("uri", "") == currentUri }
            queueCurrentIndex = if (requestedIndex >= 0) requestedIndex else 0
            updateQueuePointerByUri(currentTrackUri)
            Log.i(
                "PulseDLNAQueue",
                "QueueContext applied context=$queueContextId incoming=$incomingTrackCount stored=${queueTracks.size} index=$queueCurrentIndex currentUri=$currentUri",
            )
            val payload = JSONObject()
            payload.put("tracks", JSONArray(queueTracks))
            payload.put("currentIndex", queueCurrentIndex)
            payload.put("totalTracks", queueTotalTracks)
            payload.put("contextId", queueContextId)
            PulseDLNAControlBridge.emit("DLNA_QUEUE_CONTEXT", mapOf("json" to payload.toString()))
            """{"ok":true}"""
        }.getOrElse {
            """{"ok":false}"""
        }
    }

    private fun handleRenderingControl(actionHeader: String, body: String): String {
        val action = actionHeader.substringAfter("#").substringBefore("\"")
        when (action) {
            "SetVolume" -> {
                volume = extractXmlValue(body, "DesiredVolume").toIntOrNull()?.coerceIn(0, 100) ?: volume
                PulseDLNAControlBridge.emit("DLNA_SET_VOLUME", mapOf("volume" to volume.toString()))
            }
            "SetMute" -> {
                muted = extractXmlValue(body, "DesiredMute") == "1"
                PulseDLNAControlBridge.emit("DLNA_SET_MUTE", mapOf("muted" to if (muted) "1" else "0"))
            }
            "GetVolume" -> return soapResponse("u:GetVolumeResponse", "urn:schemas-upnp-org:service:RenderingControl:1", "<CurrentVolume>$volume</CurrentVolume>")
            "GetMute" -> return soapResponse("u:GetMuteResponse", "urn:schemas-upnp-org:service:RenderingControl:1", "<CurrentMute>${if (muted) 1 else 0}</CurrentMute>")
        }
        return soapResponse("u:${action}Response", "urn:schemas-upnp-org:service:RenderingControl:1", "")
    }

    private fun handleConnectionManager(actionHeader: String, _body: String): String {
        val action = actionHeader.substringAfter("#").substringBefore("\"")
        return when (action) {
            "GetProtocolInfo" -> soapResponse("u:GetProtocolInfoResponse", "urn:schemas-upnp-org:service:ConnectionManager:1", "<Source></Source><Sink>http-get:*:audio/*:*</Sink>")
            "GetCurrentConnectionIDs" -> soapResponse("u:GetCurrentConnectionIDsResponse", "urn:schemas-upnp-org:service:ConnectionManager:1", "<ConnectionIDs>0</ConnectionIDs>")
            "GetCurrentConnectionInfo" -> soapResponse("u:GetCurrentConnectionInfoResponse", "urn:schemas-upnp-org:service:ConnectionManager:1", "<RcsID>0</RcsID><AVTransportID>0</AVTransportID><ProtocolInfo>http-get:*:audio/*:*</ProtocolInfo><PeerConnectionManager></PeerConnectionManager><PeerConnectionID>-1</PeerConnectionID><Direction>Input</Direction><Status>OK</Status>")
            else -> soapResponse("u:${action}Response", "urn:schemas-upnp-org:service:ConnectionManager:1", "")
        }
    }

    private fun writeHttp(output: OutputStream, code: Int, contentType: String, body: String) {
        val bytes = body.toByteArray(StandardCharsets.UTF_8)
        val response = "HTTP/1.1 $code OK\r\nContent-Type: $contentType\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
        output.write(response.toByteArray(StandardCharsets.UTF_8))
        output.write(bytes)
        output.flush()
    }

    private fun soapResponse(actionTag: String, serviceNs: String, innerXml: String): String {
        return """
            <?xml version="1.0" encoding="utf-8"?>
            <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
              <s:Body>
                <$actionTag xmlns:u="$serviceNs">$innerXml</$actionTag>
              </s:Body>
            </s:Envelope>
        """.trimIndent()
    }

    private fun buildDescriptionXml(): String {
        val base = getBaseUrl()
        return """
            <?xml version="1.0"?>
            <root xmlns="urn:schemas-upnp-org:device-1-0">
              <specVersion><major>1</major><minor>0</minor></specVersion>
              <URLBase>$base/</URLBase>
              <device>
                <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
                <friendlyName>Aurora Pulse Launcher</friendlyName>
                <manufacturer>Aurora</manufacturer>
                <modelName>PulseLauncherDLNA</modelName>
                <UDN>$serviceUuid</UDN>
                <serviceList>
                  <service>
                    <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
                    <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
                    <SCPDURL>/upnp/scpd/avtransport.xml</SCPDURL>
                    <controlURL>/upnp/control/avtransport</controlURL>
                    <eventSubURL>/upnp/event/avtransport</eventSubURL>
                  </service>
                  <service>
                    <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
                    <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
                    <SCPDURL>/upnp/scpd/renderingcontrol.xml</SCPDURL>
                    <controlURL>/upnp/control/renderingcontrol</controlURL>
                    <eventSubURL>/upnp/event/renderingcontrol</eventSubURL>
                  </service>
                  <service>
                    <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
                    <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
                    <SCPDURL>/upnp/scpd/connectionmanager.xml</SCPDURL>
                    <controlURL>/upnp/control/connectionmanager</controlURL>
                    <eventSubURL>/upnp/event/connectionmanager</eventSubURL>
                  </service>
                </serviceList>
              </device>
            </root>
        """.trimIndent()
    }

    private fun getLocationUrl(): String {
        val base = getBaseUrl()
        if (base.isBlank()) return ""
        return "$base/description.xml"
    }

    private fun getBaseUrl(): String {
        val ip = getLocalWifiIpv4Address() ?: return ""
        if (httpPort <= 0) return ""
        return "http://$ip:$httpPort"
    }

    private fun extractXmlValue(xml: String, tag: String): String {
        val regex = Regex("<(?:\\w+:)?$tag[^>]*>([\\s\\S]*?)</(?:\\w+:)?$tag>", RegexOption.IGNORE_CASE)
        return regex.find(xml)?.groupValues?.getOrNull(1)?.trim().orEmpty()
    }

    private fun decodeXmlEntities(value: String): String {
        var result = value
        repeat(3) {
            val decoded = result
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .replace("&#39;", "'")
                .replace("&#x27;", "'")
                .replace("&amp;", "&")
            if (decoded == result) {
                return decoded
            }
            result = decoded
        }
        return result
    }

    private fun parseDidlMeta(rawMetadata: String): Map<String, String> {
        val metadata = decodeXmlEntities(rawMetadata)
        fun capture(pattern: String): String? {
            return Regex(pattern, RegexOption.IGNORE_CASE).find(metadata)?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.isNotBlank() }
        }
        val title = capture("<dc:title[^>]*>(.*?)</dc:title>") ?: capture("<title[^>]*>(.*?)</title>")
        val artist = capture("<upnp:artist[^>]*>(.*?)</upnp:artist>") ?: capture("<artist[^>]*>(.*?)</artist>")
        val albumArt = capture("<upnp:albumArtURI[^>]*>(.*?)</upnp:albumArtURI>") ?: capture("<albumArtURI[^>]*>(.*?)</albumArtURI>")
        val duration = capture("<res[^>]*duration=\"([^\"]+)\"[^>]*>")
        val result = mutableMapOf<String, String>()
        if (title != null) result["title"] = title
        if (artist != null) result["artist"] = artist
        if (albumArt != null) result["albumArt"] = albumArt
        if (duration != null) result["duration"] = duration
        return result
    }

    private fun absolutizeUri(candidate: String, contextUri: String): String {
        if (candidate.isBlank()) {
            return ""
        }
        if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
            return candidate
        }
        if (!candidate.startsWith("/")) {
            return candidate
        }
        return runCatching {
            val source = java.net.URI(contextUri)
            "${source.scheme}://${source.host}${if (source.port > 0) ":${source.port}" else ""}$candidate"
        }.getOrDefault(candidate)
    }

    private fun updateQueuePointerByUri(uri: String) {
        if (uri.isBlank() || queueTracks.isEmpty()) {
            return
        }
        val index = queueTracks.indexOfFirst { it.optString("uri", "") == uri }
        if (index >= 0) {
            queueCurrentIndex = index
            val nextIndex = index + 1
            nextTrackUri = if (nextIndex in queueTracks.indices) queueTracks[nextIndex].optString("uri", nextTrackUri) else nextTrackUri
        }
    }

    private fun ensureQueueContainsNextTrack(nextUri: String, meta: Map<String, String>) {
        if (nextUri.isBlank()) {
            return
        }
        val existing = queueTracks.indexOfFirst { it.optString("uri", "") == nextUri }
        if (existing >= 0) {
            queueTotalTracks = queueTracks.size.coerceAtLeast(1)
            return
        }
        val entry = JSONObject()
        entry.put("uri", nextUri)
        entry.put("title", meta["title"] ?: "")
        entry.put("artist", meta["artist"] ?: "")
        entry.put("albumArt", absolutizeUri(meta["albumArt"] ?: "", nextUri))
        val insertIndex = (queueCurrentIndex + 1).coerceAtMost(queueTracks.size)
        queueTracks.add(insertIndex, entry)
        queueTotalTracks = queueTracks.size.coerceAtLeast(1)
    }

    private fun parseDurationToMs(value: String): Long {
        val parts = value.substringBefore('.').split(":")
        if (parts.size != 3) {
            return 0
        }
        val h = parts[0].toLongOrNull() ?: 0
        val m = parts[1].toLongOrNull() ?: 0
        val s = parts[2].toLongOrNull() ?: 0
        return ((h * 3600) + (m * 60) + s) * 1000L
    }

    private fun formatMsToHms(value: Long): String {
        val totalSeconds = (value.coerceAtLeast(0) / 1000L).toInt()
        val h = totalSeconds / 3600
        val m = (totalSeconds % 3600) / 60
        val s = totalSeconds % 60
        return String.format(Locale.US, "%02d:%02d:%02d", h, m, s)
    }

    private fun escapeXml(value: String): String {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    }

    private fun acquireMulticastLock() {
        runCatching {
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            multicastLock = wifiManager.createMulticastLock("PulseDLNA-MulticastLock").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun acquireWifiLock() {
        runCatching {
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "PulseDLNA-WifiLock").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun createForegroundNotification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(channelId, "Pulse DLNA Renderer", NotificationManager.IMPORTANCE_LOW),
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, channelId) else Notification.Builder(this)
        return builder
            .setContentTitle("Pulse DLNA Renderer")
            .setContentText("Nativ aktiv")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .build()
    }

    fun isRendererRegistered(): Boolean = running.get() && httpPort > 0

    fun isMulticastLockActive(): Boolean = multicastLock?.isHeld == true

    fun updatePlaybackState(state: String, positionMs: Long, durationMs: Long) {
        transportState = when (state.lowercase(Locale.US)) {
            "playing" -> "PLAYING"
            "paused" -> "PAUSED_PLAYBACK"
            else -> "STOPPED"
        }
        currentPositionMs = positionMs.coerceAtLeast(0)
        currentDurationMs = durationMs.coerceAtLeast(0)
    }

    fun updatePlaybackTrack(
        uri: String,
        title: String,
        artist: String,
        albumArt: String,
        queueIndex: Int,
        queueSize: Int,
    ) {
        val normalizedUri = uri.trim()
        if (normalizedUri.isBlank()) {
            return
        }
        currentTrackUri = normalizedUri
        currentTrackTitle = title
        currentTrackArtist = artist
        currentTrackAlbumArt = albumArt
        queueTotalTracks = queueSize.coerceAtLeast(1)
        if (queueTracks.isNotEmpty()) {
            updateQueuePointerByUri(normalizedUri)
        }
        if (queueIndex >= 0) {
            queueCurrentIndex = queueIndex.coerceIn(0, (queueTotalTracks - 1).coerceAtLeast(0))
            if (queueTracks.isNotEmpty() && queueCurrentIndex in queueTracks.indices) {
                currentTrackUri = queueTracks[queueCurrentIndex].optString("uri", currentTrackUri)
            }
        }
        if (queueTracks.isNotEmpty()) {
            val nextIndex = queueCurrentIndex + 1
            nextTrackUri = if (nextIndex in queueTracks.indices) queueTracks[nextIndex].optString("uri", nextTrackUri) else ""
        }
        Log.i(
            "PulseDLNAQueue",
            "PlaybackTrack updated context=$queueContextId queueSize=$queueTotalTracks index=$queueCurrentIndex uri=$currentTrackUri",
        )
    }

    fun getLocalWifiIpv4Address(): String? {
        return runCatching {
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val value = wifiManager.connectionInfo?.ipAddress ?: 0
            if (value != 0) {
                val b1 = value and 0xff
                val b2 = (value shr 8) and 0xff
                val b3 = (value shr 16) and 0xff
                val b4 = (value shr 24) and 0xff
                return@runCatching "$b1.$b2.$b3.$b4"
            }
            Collections.list(NetworkInterface.getNetworkInterfaces() ?: return@runCatching null)
                ?.asSequence()
                ?.filter { it.isUp && !it.isLoopback }
                ?.flatMap { Collections.list(it.inetAddresses).asSequence() }
                ?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress && it.hostAddress != null }
                ?.hostAddress
        }.getOrNull()?.substringBefore('%')
    }
}
