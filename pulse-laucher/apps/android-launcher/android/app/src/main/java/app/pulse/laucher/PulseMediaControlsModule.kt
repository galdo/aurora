package app.pulse.laucher

import android.content.Intent
import android.graphics.Canvas
import android.graphics.BitmapFactory
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.InputStream

/** Exposes [MediaSessionCompat.getSessionToken] for [NotificationCompat.MediaStyle] (lock screen / system UI). */
internal object PulseMediaSessionBridge {
  @Volatile
  @JvmStatic
  var sessionToken: MediaSessionCompat.Token? = null
}

class PulseMediaControlsModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

  private val mediaSession: MediaSessionCompat = MediaSessionCompat(reactContext, "AuroraPulseMediaSession")
  private var sessionActive: Boolean = true
  private var playbackState: String = "stopped"
  private var positionMs: Long = 0L
  private var durationMs: Long = 0L
  private var trackTitle: String = "Aurora Pulse"
  private var trackArtist: String = "Bereit"
  private var trackAlbum: String = "Aurora Pulse"
  private var trackArtworkUri: String = ""
  private var trackQueueIndex: Int = 0
  private var trackQueueSize: Int = 1
  private var trackProfileName: String = ""
  private var lastNotificationSignature: String = ""
  private var lastNotificationSyncAtMs: Long = 0L
  private val notificationMinIntervalMs: Long = 1200L

  init {
    mediaSession.setFlags(MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS)
    mediaSession.setCallback(object : MediaSessionCompat.Callback() {
      override fun onPlay() {
        emitCommand("play")
      }

      override fun onPause() {
        emitCommand("pause")
      }

      override fun onStop() {
        emitCommand("pause")
      }

      override fun onSkipToNext() {
        emitCommand("next")
      }

      override fun onSkipToPrevious() {
        emitCommand("previous")
      }

      override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
        val keyEvent = mediaButtonIntent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT) ?: return super.onMediaButtonEvent(mediaButtonIntent)
        if (keyEvent.action != KeyEvent.ACTION_DOWN) {
          return true
        }
        when (keyEvent.keyCode) {
          KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> emitCommand("play_pause")
          KeyEvent.KEYCODE_MEDIA_PLAY -> emitCommand("play")
          KeyEvent.KEYCODE_MEDIA_PAUSE -> emitCommand("pause")
          KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> emitCommand("next")
          KeyEvent.KEYCODE_MEDIA_PREVIOUS, KeyEvent.KEYCODE_MEDIA_REWIND -> emitCommand("previous")
          else -> return super.onMediaButtonEvent(mediaButtonIntent)
        }
        return true
      }
    }, Handler(Looper.getMainLooper()))
    mediaSession.isActive = true
    PulseMediaSessionBridge.sessionToken = mediaSession.sessionToken
    applyPlaybackState()
    PulseMediaControlBridge.commandListener = { command -> emitCommand(command) }
  }

  override fun getName(): String = "PulseMediaControlsModule"

  @ReactMethod
  fun addListener(_eventName: String) {
  }

  @ReactMethod
  fun removeListeners(_count: Int) {
  }

  @ReactMethod
  fun setSessionActive(active: Boolean, promise: Promise) {
    sessionActive = active
    mediaSession.isActive = active
    if (active) {
      syncForegroundNotification(true)
    } else {
      PulseMediaNotificationService.stop(reactContext)
    }
    promise.resolve(true)
  }

  @ReactMethod
  fun updatePlaybackState(state: String, position: Double, duration: Double, promise: Promise) {
    val normalizedState = state.lowercase()
    val stateChanged = playbackState.lowercase() != normalizedState
    playbackState = state
    positionMs = position.toLong().coerceAtLeast(0L)
    durationMs = duration.toLong().coerceAtLeast(0L)
    applyPlaybackState()
    if (stateChanged) {
      syncForegroundNotification(true)
    }
    promise.resolve(true)
  }

  @ReactMethod
  fun updatePlaybackTrack(
    title: String,
    artist: String,
    album: String,
    artworkUri: String,
    queueIndex: Double,
    queueSize: Double,
    durationMs: Double,
    profileName: String,
    promise: Promise,
  ) {
    val resolvedQueueIndex = queueIndex.toInt().coerceAtLeast(0)
    val resolvedQueueSize = queueSize.toInt().coerceAtLeast(1)
    trackTitle = title
    trackArtist = artist
    trackAlbum = album.ifBlank { "Aurora Pulse" }
    trackArtworkUri = artworkUri
    trackQueueIndex = resolvedQueueIndex
    trackQueueSize = resolvedQueueSize
    this.durationMs = durationMs.toLong().coerceAtLeast(0L)
    trackProfileName = profileName
    val subtitle = buildString {
      append("${resolvedQueueIndex + 1}/${resolvedQueueSize}")
      if (profileName.isNotBlank()) {
        append(" · EQ: ")
        append(profileName)
      }
    }
    val metadata = MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, trackTitle)
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, trackArtist)
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, trackAlbum)
      .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, subtitle)
      .putLong(MediaMetadataCompat.METADATA_KEY_TRACK_NUMBER, (resolvedQueueIndex + 1).toLong())
      .putLong(MediaMetadataCompat.METADATA_KEY_NUM_TRACKS, resolvedQueueSize.toLong())
      .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs.toLong().coerceAtLeast(0L))
      .apply {
        val artworkBitmap = decodeArtworkBitmap(artworkUri)
        if (artworkBitmap != null) {
          putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artworkBitmap)
          putBitmap(MediaMetadataCompat.METADATA_KEY_ART, artworkBitmap)
          putBitmap(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON, artworkBitmap)
        } else if (artworkUri.isNotBlank()) {
          putString(MediaMetadataCompat.METADATA_KEY_ALBUM_ART_URI, artworkUri)
          putString(MediaMetadataCompat.METADATA_KEY_ART_URI, artworkUri)
          putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_ICON_URI, artworkUri)
        }
      }
      .build()
    mediaSession.setMetadata(metadata)
    syncForegroundNotification(true)
    promise.resolve(true)
  }

  private fun applyPlaybackState() {
    val stateValue = when (playbackState.lowercase()) {
      "playing" -> PlaybackStateCompat.STATE_PLAYING
      "paused" -> PlaybackStateCompat.STATE_PAUSED
      else -> PlaybackStateCompat.STATE_STOPPED
    }
    val actions = PlaybackStateCompat.ACTION_PLAY_PAUSE or
      PlaybackStateCompat.ACTION_PLAY or
      PlaybackStateCompat.ACTION_PAUSE or
      PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
      PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
      PlaybackStateCompat.ACTION_STOP
    val state = PlaybackStateCompat.Builder()
      .setActions(actions)
      .setState(stateValue, positionMs, 1f)
      .build()
    mediaSession.setPlaybackState(state)
  }

  private fun emitCommand(command: String) {
    val payload = Arguments.createMap()
    payload.putString("command", command)
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("MEDIA_CONTROL_COMMAND", payload)
  }

  private fun syncForegroundNotification(force: Boolean = false) {
    if (!sessionActive) {
      return
    }
    val notificationSignature = buildString {
      append(trackTitle)
      append('\u0000')
      append(trackArtist)
      append('\u0000')
      append(trackAlbum)
      append('\u0000')
      append(trackArtworkUri)
      append('\u0000')
      append(trackQueueIndex)
      append('/')
      append(trackQueueSize)
      append('\u0000')
      append(playbackState.lowercase())
      append('\u0000')
      append(trackProfileName)
    }
    val now = SystemClock.elapsedRealtime()
    if (!force
      && notificationSignature == lastNotificationSignature
      && (now - lastNotificationSyncAtMs) < notificationMinIntervalMs) {
      return
    }
    lastNotificationSignature = notificationSignature
    lastNotificationSyncAtMs = now
    PulseMediaNotificationService.startOrUpdate(
      reactContext,
      trackTitle,
      trackArtist,
      trackAlbum,
      trackArtworkUri,
      trackQueueIndex,
      trackQueueSize,
      playbackState.lowercase() == "playing",
      trackProfileName,
    )
  }

  private fun decodeArtworkBitmap(uri: String): android.graphics.Bitmap? {
    val resolved = if (uri.isBlank()) {
      null
    } else {
      runCatching {
        val inputStream: InputStream? = when {
          uri.startsWith("content://", ignoreCase = true) -> reactContext.contentResolver.openInputStream(android.net.Uri.parse(uri))
          uri.startsWith("file://", ignoreCase = true) -> reactContext.contentResolver.openInputStream(android.net.Uri.parse(uri))
          else -> null
        }
        inputStream?.use { stream ->
          BitmapFactory.decodeStream(stream)
        }
      }.getOrNull()
    }
    if (resolved != null) {
      return resolved
    }
    return drawableToBitmap(reactContext.applicationInfo.loadIcon(reactContext.packageManager))
  }

  private fun drawableToBitmap(drawable: Drawable): android.graphics.Bitmap {
    if (drawable is BitmapDrawable && drawable.bitmap != null) {
      return drawable.bitmap
    }
    val width = if (drawable.intrinsicWidth > 0) drawable.intrinsicWidth else 128
    val height = if (drawable.intrinsicHeight > 0) drawable.intrinsicHeight else 128
    val bitmap = android.graphics.Bitmap.createBitmap(width, height, android.graphics.Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    drawable.setBounds(0, 0, canvas.width, canvas.height)
    drawable.draw(canvas)
    return bitmap
  }

  override fun invalidate() {
    PulseMediaControlBridge.commandListener = null
    mediaSession.isActive = false
    PulseMediaSessionBridge.sessionToken = null
    PulseMediaNotificationService.stop(reactContext)
    mediaSession.release()
    super.invalidate()
  }
}
