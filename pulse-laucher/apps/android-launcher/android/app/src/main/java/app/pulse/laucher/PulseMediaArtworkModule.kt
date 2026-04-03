package app.pulse.laucher

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.webkit.MimeTypeMap
import androidx.documentfile.provider.DocumentFile
import com.facebook.react.bridge.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.io.InputStreamReader
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale

class PulseMediaArtworkModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private data class DocumentMeta(
    val mimeType: String?,
    val displayName: String?,
    val lastModified: Long?,
  )

  private val documentMetaCache = HashMap<String, DocumentMeta>()
  private val folderEmbeddedArtworkProbeState = HashMap<String, Boolean>()

  override fun getName(): String = "PulseMediaArtworkModule"

  @ReactMethod
  fun getMetadataForUris(uris: ReadableArray, promise: Promise) {
    val list = mutableListOf<String>()
    for (i in 0 until uris.size()) {
      val value = uris.getString(i) ?: continue
      if (value.isNotBlank()) list.add(value)
    }
    if (list.isEmpty()) {
      promise.resolve(Arguments.createArray())
      return
    }
    folderEmbeddedArtworkProbeState.clear()
    val result = Arguments.createArray()
    runBlocking {
      val scope = CoroutineScope(Dispatchers.IO)
      val tasks = list.chunked(64).map { batch ->
        scope.async {
          batch.mapNotNull { uriStr ->
            val uri = Uri.parse(uriStr)
            if (!isAudioDocumentUri(uri)) {
              return@mapNotNull null
            }
            runCatching { extractMetadata(reactContext, uri) }.getOrNull()
          }
        }
      }
      tasks.forEach { task ->
        task.await().forEach { map -> result.pushMap(map) }
      }
    }
    promise.resolve(result)
  }

  @ReactMethod
  fun listAudioEntriesFromRoots(rootUris: ReadableArray, promise: Promise) {
    folderEmbeddedArtworkProbeState.clear()
    val roots = readableToStringList(rootUris)
    val entries = Arguments.createArray()
    val folderArtworkByFolderPath = HashMap<String, String>()
    val stats = traverseTreeDocuments(roots, 12000) { uri, mimeType, displayName, lastModified ->
      val effectiveMime = (mimeType ?: guessMimeFromName(displayName.orEmpty()) ?: "").lowercase(Locale.US)
      if (effectiveMime.startsWith("image/")) {
        val folderPath = getParentLibraryPath(getLibraryPathFromUri(uri))
        if (folderPath.isNotBlank()) {
          val existing = folderArtworkByFolderPath[folderPath]
          if (existing == null || isPreferredArtworkFileName(displayName)) {
            folderArtworkByFolderPath[folderPath] = uri.toString()
          }
        }
        return@traverseTreeDocuments
      }
      if (!effectiveMime.startsWith("audio/")) {
        return@traverseTreeDocuments
      }
      if (isPlaylistLikeEntry(effectiveMime, displayName)) {
        return@traverseTreeDocuments
      }
      val map = Arguments.createMap()
      map.putString("uri", uri.toString())
      map.putString("displayName", (displayName ?: "Audio").ifBlank { "Audio" })
      map.putString("mimeType", effectiveMime)
      map.putDouble("lastModified", (lastModified ?: 0L).toDouble())
      entries.pushMap(map)
    }
    val payload = Arguments.createMap()
    payload.putArray("entries", entries)
    payload.putInt("visitedNodes", stats.visitedNodes)
    payload.putInt("leafNodes", stats.leafNodes)
    payload.putInt("readErrors", stats.readErrors)
    payload.putString("lastError", stats.lastError)
    val artworkMap = Arguments.createMap()
    folderArtworkByFolderPath.forEach { (key, value) ->
      artworkMap.putString(key, value)
    }
    payload.putMap("folderArtworkByFolderPath", artworkMap)
    promise.resolve(payload)
  }

  @ReactMethod
  fun listPlaylistEntriesFromRoots(rootUris: ReadableArray, promise: Promise) {
    folderEmbeddedArtworkProbeState.clear()
    val roots = readableToStringList(rootUris)
    val resolver = reactContext.contentResolver
    val entries = Arguments.createArray()
    val stats = traverseTreeDocuments(roots, 12000) { uri, _mimeType, displayName, lastModified ->
      val name = (displayName ?: "").lowercase(Locale.US)
      if (!name.endsWith(".m3u") && !name.endsWith(".m3u8")) {
        return@traverseTreeDocuments
      }
      val trackUris = Arguments.createArray()
      runCatching {
        resolver.openInputStream(uri)?.use { input ->
          BufferedReader(InputStreamReader(input)).use { br ->
            var line: String?
            while (br.readLine().also { line = it } != null) {
              val raw = line!!.trim()
              if (raw.isEmpty() || raw.startsWith("#")) continue
              trackUris.pushString(raw)
              if (trackUris.size() >= 5000) break
            }
          }
        }
      }
      val map = Arguments.createMap()
      map.putString("uri", uri.toString())
      map.putString("displayName", (displayName ?: "Playlist").ifBlank { "Playlist" })
      map.putDouble("lastModified", (lastModified ?: 0L).toDouble())
      map.putArray("trackUris", trackUris)
      entries.pushMap(map)
    }
    val payload = Arguments.createMap()
    payload.putArray("entries", entries)
    payload.putInt("visitedNodes", stats.visitedNodes)
    payload.putInt("readErrors", stats.readErrors)
    payload.putString("lastError", stats.lastError)
    promise.resolve(payload)
  }

  @ReactMethod
  fun scanMetadataFromRoots(rootUris: ReadableArray, promise: Promise) {
    folderEmbeddedArtworkProbeState.clear()
    val roots = readableToStringList(rootUris)
    val rows = Arguments.createArray()
    val audioUris = ArrayList<Uri>()
    val stats = traverseTreeDocuments(roots, 8000) { uri, mimeType, displayName, _lastModified ->
      val effectiveMime = (mimeType ?: guessMimeFromName(displayName.orEmpty()) ?: "").lowercase(Locale.US)
      if (effectiveMime.startsWith("audio/") && !isPlaylistLikeEntry(effectiveMime, displayName)) {
        audioUris.add(uri)
      }
    }
    runBlocking {
      val scope = CoroutineScope(Dispatchers.IO)
      val tasks = audioUris.chunked(64).map { chunk ->
        scope.async {
          chunk.mapNotNull { uri ->
            runCatching { extractMetadata(reactContext, uri) }.getOrNull()
          }
        }
      }
      tasks.forEach { task ->
        task.await().forEach { map -> rows.pushMap(map) }
      }
    }
    val payload = Arguments.createMap()
    payload.putArray("rows", rows)
    payload.putInt("visitedNodes", stats.visitedNodes)
    payload.putInt("leafNodes", stats.leafNodes)
    payload.putInt("readErrors", stats.readErrors)
    payload.putString("lastError", stats.lastError)
    payload.putInt("metadataRows", rows.size())
    promise.resolve(payload)
  }

  @ReactMethod
  fun startLibrarySync(rootUris: ReadableArray, promise: Promise) {
    val roots = readableToStringList(rootUris)
    val intent = Intent(reactContext, LibrarySyncService::class.java).apply {
      action = LibrarySyncService.ACTION_START
      putStringArrayListExtra(LibrarySyncService.EXTRA_ROOT_URIS, ArrayList(roots))
    }
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        reactContext.startForegroundService(intent)
      } else {
        reactContext.startService(intent)
      }
      promise.resolve(true)
    }.onFailure {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun cancelLibrarySync(promise: Promise) {
    val intent = Intent(reactContext, LibrarySyncService::class.java).apply {
      action = LibrarySyncService.ACTION_CANCEL
    }
    runCatching {
      reactContext.startService(intent)
      promise.resolve(true)
    }.onFailure {
      promise.resolve(false)
    }
  }

  @ReactMethod
  fun getLibrarySyncStatus(promise: Promise) {
    promise.resolve(LibrarySyncCoordinator.getStatus().toWritableMap())
  }

  @ReactMethod
  fun getLibraryCachedRows(rootUris: ReadableArray, promise: Promise) {
    val roots = readableToStringList(rootUris)
    val rootKey = roots.filter { it.isNotBlank() }.sorted().joinToString("|")
    if (rootKey.isBlank()) {
      promise.resolve(Arguments.createArray())
      return
    }
    val db = LibraryIndexDatabase.getInstance(reactContext)
    val rows = Arguments.createArray()
    runCatching {
      db.queryAllForRoot(rootKey).forEach { row ->
        val map = Arguments.createMap()
        map.putString("uri", row.uri)
        map.putString("title", row.title)
        map.putString("artist", row.artist)
        map.putString("albumArtist", row.albumArtist)
        map.putString("album", row.album)
        map.putString("durationMs", row.durationMs.toString())
        map.putString("mimeType", row.mimeType)
        map.putString("sourceLastModified", row.lastModified.toString())
        map.putString("artworkUri", row.artworkUri)
        rows.pushMap(map)
      }
    }
    promise.resolve(rows)
  }

  @ReactMethod
  fun getLibraryCachedAlbums(rootUris: ReadableArray, promise: Promise) {
    val roots = readableToStringList(rootUris)
    val rootKey = roots.filter { it.isNotBlank() }.sorted().joinToString("|")
    if (rootKey.isBlank()) {
      promise.resolve(Arguments.createMap())
      return
    }
    val db = LibraryIndexDatabase.getInstance(reactContext)
    val payload = Arguments.createMap()
    val albums = Arguments.createArray()
    runCatching {
      val rows = db.queryAllForRoot(rootKey)
      val artworkThumbCache = HashMap<String, String>()
      val rootInfos = roots
        .map { getLibraryPathFromUri(Uri.parse(it)) }
        .filter { it.isNotBlank() }
        .map { path -> RootPathInfo(path, path.lowercase(Locale.US)) }
        .sortedByDescending { it.normalized.length }
      val byFolder = LinkedHashMap<String, MutableList<LibraryTrackRecord>>()
      rows.forEach { row ->
        val folderKey = getAlbumFolderKeyFromUriString(row.uri, rootInfos)
        val bucket = byFolder[folderKey]
        if (bucket != null) {
          bucket.add(row)
        } else {
          byFolder[folderKey] = mutableListOf(row)
        }
      }
      val albumItems = mutableListOf<CachedAlbumItem>()
      byFolder.forEach { (folderKey, folderRows) ->
        if (folderRows.isEmpty()) {
          return@forEach
        }
        val first = folderRows.first()
        val classification = evaluateCollectionClassification(folderRows, folderKey)
        val artistCounts = HashMap<String, Int>()
        val albumArtistCounts = HashMap<String, Int>()
        folderRows.forEach { row ->
          val artist = row.artist.trim()
          if (artist.isNotEmpty()) {
            artistCounts[artist] = (artistCounts[artist] ?: 0) + 1
          }
          val albumArtist = row.albumArtist.trim()
          if (albumArtist.isNotEmpty()) {
            albumArtistCounts[albumArtist] = (albumArtistCounts[albumArtist] ?: 0) + 1
          }
        }
        var bestArtist = "Unbekannter Interpret"
        var maxCount = 0
        artistCounts.forEach { (artist, count) ->
          if (count > maxCount) {
            maxCount = count
            bestArtist = artist
          }
        }
        var bestAlbumArtist = ""
        var maxAlbumArtistCount = 0
        albumArtistCounts.forEach { (albumArtist, count) ->
          if (count > maxAlbumArtistCount) {
            maxAlbumArtistCount = count
            bestAlbumArtist = albumArtist
          }
        }
        val distinctArtworks = folderRows.map { it.artworkUri.trim() }.filter { it.isNotEmpty() }.distinct()
        val fallbackArtwork = distinctArtworks.firstOrNull().orEmpty().ifBlank { first.artworkUri }
        val fallbackArtworkThumb = toThumbnailUriCached(fallbackArtwork, folderKey, artworkThumbCache)
        val randomizedArtworks = distinctArtworks.sortedBy { hashStableInt("$folderKey|$it") }
        val mosaic = if (classification.isCollection) {
          if (randomizedArtworks.size >= 2) {
            val selected = randomizedArtworks.take(4).toMutableList()
            while (selected.size < 4 && randomizedArtworks.isNotEmpty()) {
              selected.add(randomizedArtworks[selected.size % randomizedArtworks.size])
            }
            selected.mapIndexed { index, uri ->
              toThumbnailUriCached(uri, "$folderKey#$index", artworkThumbCache)
            }
          } else if (fallbackArtworkThumb.isNotBlank()) {
            listOf(fallbackArtworkThumb, fallbackArtworkThumb, fallbackArtworkThumb, fallbackArtworkThumb)
          } else {
            listOf("tile://0", "tile://1", "tile://2", "tile://3")
          }
        } else {
          emptyList()
        }
        val title = if (classification.isCollection) inferFolderLabel(folderKey) else sanitizeAlbumLabel(first.album).ifBlank { inferFolderLabel(folderKey) }
        val normalizedBestAlbumArtist = bestAlbumArtist.trim()
        val albumArtistIsVariousArtists = normalizedBestAlbumArtist.equals("various artists", ignoreCase = true)
        val shouldUseMosaicCover = classification.isCollection
        val subtitle = when {
          classification.isCollection -> "Various Artists"
          albumArtistIsVariousArtists -> "Various Artists"
          normalizedBestAlbumArtist.isNotBlank() -> normalizedBestAlbumArtist
          else -> bestArtist
        }
        val year = extractAlbumYearForSorting(title, folderKey)
        albumItems.add(
          CachedAlbumItem(
            id = "album:$folderKey",
            title = title,
            subtitle = subtitle,
            meta = if (classification.isCollection) "__mixed__" else sanitizeAlbumLabel(first.album).ifBlank { "__folder_album__" },
            artworkUri = if (shouldUseMosaicCover) "" else fallbackArtworkThumb,
            sourceUri = folderKey,
            trackCount = folderRows.size,
            mosaicArtworks = if (shouldUseMosaicCover) mosaic else emptyList(),
            sortYear = year,
          ),
        )
      }
      albumItems.sortWith(compareBy<CachedAlbumItem> { it.subtitle.lowercase(Locale.US) }
        .thenComparator { left, right ->
          val leftYear = left.sortYear
          val rightYear = right.sortYear
          if (leftYear != null && rightYear != null && leftYear != rightYear) {
            leftYear - rightYear
          } else {
            left.title.lowercase(Locale.US).compareTo(right.title.lowercase(Locale.US))
          }
        })
      albumItems.forEach { albumItem ->
        val map = Arguments.createMap()
        map.putString("id", albumItem.id)
        map.putString("title", albumItem.title)
        map.putString("subtitle", albumItem.subtitle)
        map.putString("meta", albumItem.meta)
        map.putString("artworkUri", albumItem.artworkUri)
        map.putString("sourceUri", albumItem.sourceUri)
        map.putString("collectionType", "album")
        map.putInt("trackCount", albumItem.trackCount)
        val mosaicArray = Arguments.createArray()
        albumItem.mosaicArtworks.forEach { mosaicArray.pushString(it) }
        map.putArray("mosaicArtworks", mosaicArray)
        albums.pushMap(map)
      }
      payload.putInt("rowCount", rows.size)
      payload.putArray("items", albums)
    }
    promise.resolve(payload)
  }

  private data class RootPathInfo(
    val raw: String,
    val normalized: String,
  )

  private data class CollectionClassification(
    val isCollection: Boolean,
    val uniqueAlbumCount: Int,
    val artistsCount: Int,
  )

  private data class CachedAlbumItem(
    val id: String,
    val title: String,
    val subtitle: String,
    val meta: String,
    val artworkUri: String,
    val sourceUri: String,
    val trackCount: Int,
    val mosaicArtworks: List<String>,
    val sortYear: Int?,
  )

  private fun getAlbumFolderKeyFromUriString(uriText: String, roots: List<RootPathInfo>): String {
    val uri = Uri.parse(uriText)
    val entryPath = getLibraryPathFromUri(uri)
    val normalizedEntry = entryPath.lowercase(Locale.US)
    roots.forEach { root ->
      if (normalizedEntry == root.normalized || normalizedEntry.startsWith("${root.normalized}/")) {
        val relativePath = entryPath.removePrefix(root.raw).trimStart('/')
        if (relativePath.isBlank() || !relativePath.contains("/")) {
          return root.raw
        }
        val segments = relativePath.split('/').filter { it.isNotBlank() }
        val folderSegments = segments.dropLast(1).toMutableList()
        if (folderSegments.size > 1) {
          val lastSegment = folderSegments.lastOrNull().orEmpty()
          if (Regex("^(?:cd|disc)\\s*0*\\d+$", RegexOption.IGNORE_CASE).matches(lastSegment)) {
            folderSegments.removeAt(folderSegments.size - 1)
          }
        }
        return if (folderSegments.isNotEmpty()) {
          "${root.raw}/${folderSegments.joinToString("/")}".replace(Regex("/+"), "/")
        } else {
          root.raw
        }
      }
    }
    val parent = getParentLibraryPath(entryPath)
    if (parent.isNotBlank()) {
      val parts = parent.split('/')
      val last = parts.lastOrNull().orEmpty()
      if (Regex("^(?:cd|disc)\\s*0*\\d+$", RegexOption.IGNORE_CASE).matches(last)) {
        return getParentLibraryPath(parent).ifBlank { parent }
      }
      return parent
    }
    return "__library-root__"
  }

  private fun sanitizeAlbumLabel(value: String?): String {
    val raw = (value ?: "").trim()
    if (raw.isEmpty()) return ""
    val normalized = raw.lowercase(Locale.US)
    if (normalized.startsWith("content://")) return ""
    if (raw.contains(':') && raw.contains('/')) return ""
    if (raw.length > 64 && !raw.contains(' ')) return ""
    return raw
  }

  private fun normalizeAlbumCollectionKey(value: String): String {
    if (value.isBlank()) return ""
    return value
      .lowercase(Locale.US)
      .replace(Regex("\\[[^\\]]*\\]"), " ")
      .replace(Regex("\\([^)]*\\)"), " ")
      .replace(Regex("\\b(?:cd|disc)\\s*0*\\d{1,2}\\b", RegexOption.IGNORE_CASE), " ")
      .replace(Regex("[–—-]\\s*(?:cd|disc)\\s*0*\\d{1,2}\\b", RegexOption.IGNORE_CASE), " ")
      .replace(Regex("\\s+"), " ")
      .trim()
  }

  private fun evaluateCollectionClassification(rows: List<LibraryTrackRecord>, folderKeyHint: String): CollectionClassification {
    val hasDiscSubfolders = rows.any { row ->
      val segments = getLibraryPathFromUri(Uri.parse(row.uri)).split('/').filter { it.isNotBlank() }
      segments.any { Regex("^(?:cd|disc)\\s*0*\\d{1,2}$", RegexOption.IGNORE_CASE).matches(it) }
    }
    val albumCounts = HashMap<String, Int>()
    rows.forEach { row ->
      val label = normalizeAlbumCollectionKey(sanitizeAlbumLabel(row.album))
      if (label.isNotBlank()) {
        albumCounts[label] = (albumCounts[label] ?: 0) + 1
      }
    }
    val uniqueAlbumCount = albumCounts.size
    val albumArtistCounts = HashMap<String, Int>()
    rows.forEach { row ->
      val resolvedAlbumArtist = row.albumArtist.trim().ifBlank { extractFileArtistHint(row.uri) }
      if (resolvedAlbumArtist.isNotBlank()) {
        val key = resolvedAlbumArtist.lowercase(Locale.US)
        albumArtistCounts[key] = (albumArtistCounts[key] ?: 0) + 1
      }
    }
    val uniqueAlbumArtistCount = albumArtistCounts.size
    val dominantAlbumArtistCount = if (albumArtistCounts.isEmpty()) 0 else albumArtistCounts.values.maxOrNull() ?: 0
    val dominantAlbumArtistShare = if (rows.isEmpty() || dominantAlbumArtistCount <= 0) {
      1.0
    } else {
      dominantAlbumArtistCount.toDouble() / rows.size.toDouble()
    }

    val trackArtists = HashSet<String>()
    rows.forEach { row ->
      val artist = row.artist.trim().lowercase(Locale.US)
      if (artist.isNotBlank()) {
        trackArtists.add(artist)
      }
    }
    val folderHint = folderKeyHint.lowercase(Locale.US)
    val collectionNameHint = folderHint.contains("remember")
      || folderHint.contains("audiophile")
      || folderHint.contains("sampler")
      || folderHint.contains("collection")
      || folderHint.contains("mix")
    val likelySingleAlbumAlbumArtistNoise = uniqueAlbumArtistCount <= 1 || dominantAlbumArtistShare >= 0.90
    val isCollection = !hasDiscSubfolders && !likelySingleAlbumAlbumArtistNoise && (
      (collectionNameHint && uniqueAlbumArtistCount >= 2)
        || (uniqueAlbumArtistCount >= 2 && dominantAlbumArtistShare < 0.90)
        || (uniqueAlbumCount >= 2 && uniqueAlbumArtistCount >= 2)
        || (uniqueAlbumCount >= 3 && uniqueAlbumArtistCount >= 2)
    )
    return CollectionClassification(
      isCollection = isCollection,
      uniqueAlbumCount = uniqueAlbumCount,
      artistsCount = trackArtists.size,
    )
  }

  private fun extractFileArtistHint(uri: String): String {
    val fileName = URLDecoder.decode(uri, StandardCharsets.UTF_8.toString())
      .substringAfterLast('/')
      .substringBeforeLast('.', "")
      .trim()
    val match = Regex("^\\d{1,3}\\.\\s*(.*?)\\s*-\\s*(.+)$").find(fileName) ?: return ""
    return match.groupValues.getOrNull(1).orEmpty().trim()
  }

  private fun inferFolderLabel(folderKey: String): String {
    val parts = folderKey.split('/').filter { it.isNotBlank() }
    return parts.lastOrNull().orEmpty().ifBlank { "Ordner" }
  }

  private fun hashStableInt(value: String): Int {
    var hash = 2166136261L
    value.forEach { ch ->
      hash = hash xor ch.code.toLong()
      hash += (hash shl 1) + (hash shl 4) + (hash shl 7) + (hash shl 8) + (hash shl 24)
    }
    return (hash and 0x7fffffff).toInt()
  }

  private fun extractAlbumYearForSorting(title: String, folderKey: String): Int? {
    val regex = Regex("\\b(19\\d{2}|20\\d{2})\\b")
    val titleMatch = regex.findAll(title).lastOrNull()?.groupValues?.getOrNull(1)?.toIntOrNull()
    if (titleMatch != null) {
      return titleMatch
    }
    return regex.findAll(folderKey).lastOrNull()?.groupValues?.getOrNull(1)?.toIntOrNull()
  }

  private fun toThumbnailUriCached(artworkUri: String, keySeed: String, cache: MutableMap<String, String>): String {
    val normalized = artworkUri.trim()
    if (normalized.isBlank()) {
      return ""
    }
    cache[normalized]?.let { return it }
    val thumb = createArtworkThumbnail(normalized, keySeed).ifBlank { normalized }
    cache[normalized] = thumb
    return thumb
  }

  private fun createArtworkThumbnail(artworkUri: String, keySeed: String): String {
    return runCatching {
      val cacheDir = File(reactContext.cacheDir, "album_art_thumbs")
      if (!cacheDir.exists()) {
        cacheDir.mkdirs()
      }
      val fileName = sha1("$keySeed|$artworkUri").take(32) + ".jpg"
      val thumbFile = File(cacheDir, fileName)
      if (thumbFile.exists() && thumbFile.length() > 0) {
        return@runCatching Uri.fromFile(thumbFile).toString()
      }
      val artwork = Uri.parse(artworkUri)
      val bytes = reactContext.contentResolver.openInputStream(artwork)?.use { input ->
        input.readBytes()
      } ?: return@runCatching artworkUri
      val options = BitmapFactory.Options().apply {
        inJustDecodeBounds = true
      }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
      val maxDimension = maxOf(options.outWidth, options.outHeight).coerceAtLeast(1)
      val sample = (maxDimension / 256).coerceAtLeast(1)
      val decodeOptions = BitmapFactory.Options().apply {
        inSampleSize = sample
      }
      val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, decodeOptions) ?: return@runCatching artworkUri
      val targetSize = 192
      val scaled = Bitmap.createScaledBitmap(decoded, targetSize, targetSize, true)
      FileOutputStream(thumbFile).use { out ->
        scaled.compress(Bitmap.CompressFormat.JPEG, 82, out)
      }
      if (scaled != decoded) {
        decoded.recycle()
      }
      scaled.recycle()
      Uri.fromFile(thumbFile).toString()
    }.getOrElse { artworkUri }
  }

  private fun sha1(value: String): String {
    val digest = MessageDigest.getInstance("SHA-1").digest(value.toByteArray(StandardCharsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }
  }

  private data class TreeTraversalStats(
    var visitedNodes: Int = 0,
    var leafNodes: Int = 0,
    var readErrors: Int = 0,
    var lastError: String = "",
  )

  private fun traverseTreeDocuments(
    roots: List<String>,
    maxLeafNodes: Int,
    onLeaf: (uri: Uri, mimeType: String?, displayName: String?, lastModified: Long?) -> Unit,
  ): TreeTraversalStats {
    val stats = TreeTraversalStats()
    val resolver = reactContext.contentResolver
    val queue = ArrayDeque<Pair<Uri, String>>()
    val seen = HashSet<String>()
    roots.forEach { root ->
      runCatching {
        val rootUri = Uri.parse(root)
        ensurePersistablePermission(resolver, rootUri)
        val treeUri = if (DocumentsContract.isTreeUri(rootUri)) {
          rootUri
        } else {
          DocumentsContract.buildTreeDocumentUri(rootUri.authority, DocumentsContract.getDocumentId(rootUri))
        }
        val rootDocId = if (DocumentsContract.isTreeUri(rootUri)) {
          DocumentsContract.getTreeDocumentId(rootUri)
        } else {
          DocumentsContract.getDocumentId(rootUri)
        }
        queue.addLast(treeUri to rootDocId)
      }.onFailure { error ->
        stats.readErrors += 1
        stats.lastError = error.message ?: "root-parse-error"
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      roots.forEach { root ->
        runCatching {
          val rootUri = Uri.parse(root)
          ensurePersistablePermission(resolver, rootUri)
          val treeUri = if (DocumentsContract.isTreeUri(rootUri)) {
            rootUri
          } else {
            DocumentsContract.buildTreeDocumentUri(rootUri.authority, DocumentsContract.getDocumentId(rootUri))
          }
          val rootDocId = if (DocumentsContract.isTreeUri(rootUri)) {
            DocumentsContract.getTreeDocumentId(rootUri)
          } else {
            DocumentsContract.getDocumentId(rootUri)
          }
          val documentUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, rootDocId)
          DocumentTreeRefresh.refreshResolver(resolver, documentUri)
        }
      }
    }
    while (queue.isNotEmpty() && stats.leafNodes < maxLeafNodes) {
      val (treeUri, parentDocId) = queue.removeFirst()
      val visitKey = "${treeUri}#${parentDocId}"
      if (!seen.add(visitKey)) {
        continue
      }
      stats.visitedNodes += 1
      runCatching {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId)
        resolver.query(
          childrenUri,
          arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            DocumentsContract.Document.COLUMN_FLAGS,
          ),
          null,
          null,
          null,
        )?.use { cursor ->
          val idIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
          val mimeIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
          val nameIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
          val modIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
          val flagsIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_FLAGS)
          while (cursor.moveToNext() && stats.leafNodes < maxLeafNodes) {
            val childDocId = if (idIndex >= 0) cursor.getString(idIndex) else null
            if (childDocId.isNullOrBlank()) {
              continue
            }
            val mimeType = if (mimeIndex >= 0) cursor.getString(mimeIndex) else null
            val displayName = if (nameIndex >= 0) cursor.getString(nameIndex) else null
            val lastModified = if (modIndex >= 0) cursor.getLong(modIndex) else null
            val rawMime = (mimeType ?: "").lowercase(Locale.US)
            val flags = if (flagsIndex >= 0) cursor.getInt(flagsIndex) else 0
            val isDirectory = rawMime == DocumentsContract.Document.MIME_TYPE_DIR.lowercase(Locale.US)
              || (flags and DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE) != 0
            if (isDirectory) {
              queue.addLast(treeUri to childDocId)
              continue
            }
            stats.leafNodes += 1
            val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, childDocId)
            onLeaf(docUri, mimeType, displayName, lastModified)
          }
        }
      }.onFailure { error ->
        stats.readErrors += 1
        stats.lastError = error.message ?: "query-error"
      }
    }
    return stats
  }

  private fun readableToStringList(array: ReadableArray): List<String> {
    val result = ArrayList<String>()
    for (i in 0 until array.size()) {
      val v = array.getString(i) ?: continue
      if (v.isNotBlank()) result.add(v)
    }
    return result
  }

  private fun listChildren(resolver: ContentResolver, parent: Uri): List<String> {
    val result = ArrayList<String>()
    return runCatching {
      ensurePersistablePermission(resolver, parent)
      val parentId = if (DocumentsContract.isTreeUri(parent)) {
        DocumentsContract.getTreeDocumentId(parent)
      } else {
        DocumentsContract.getDocumentId(parent)
      }
      val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(parent, parentId)
      resolver.query(
        childrenUri,
        arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_MIME_TYPE,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        ),
        null,
        null,
        null,
      )?.use { cursor ->
        val idIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
        val mimeIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
        val nameIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        val modIndex = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
        while (cursor.moveToNext()) {
          val docId = cursor.getString(idIndex)
          val docUri = DocumentsContract.buildDocumentUriUsingTree(parent, docId)
          val key = docUri.toString()
          val mime = if (mimeIndex >= 0) cursor.getString(mimeIndex) else null
          val name = if (nameIndex >= 0) cursor.getString(nameIndex) else null
          val modified = if (modIndex >= 0) cursor.getLong(modIndex) else null
          documentMetaCache[key] = DocumentMeta(
            mimeType = mime,
            displayName = name,
            lastModified = modified,
          )
          result.add(key)
        }
      }
      result
    }.getOrDefault(emptyList())
  }

  private fun guessMimeFromName(name: String): String? {
    val ext = name.substringAfterLast('.', "").lowercase(Locale.US)
    if (ext.isEmpty()) return null
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
  }

  private fun getDisplayNameForDocument(resolver: ContentResolver, uri: Uri): String? {
    documentMetaCache[uri.toString()]?.displayName?.let { return it }
    return runCatching {
      resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
          val idx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
          if (cursor.moveToFirst() && idx >= 0) cursor.getString(idx) else null
        }
    }.getOrNull()?.also { name ->
      val key = uri.toString()
      val current = documentMetaCache[key]
      documentMetaCache[key] = DocumentMeta(
        mimeType = current?.mimeType,
        displayName = name,
        lastModified = current?.lastModified,
      )
    }
  }

  private fun getDateModifiedForDocument(resolver: ContentResolver, uri: Uri): Long? {
    documentMetaCache[uri.toString()]?.lastModified?.let { return it }
    return runCatching {
      resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_LAST_MODIFIED), null, null, null)
        ?.use { cursor ->
          val idx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
          if (cursor.moveToFirst() && idx >= 0) cursor.getLong(idx) else null
        }
    }.getOrNull()?.also { modified ->
      val key = uri.toString()
      val current = documentMetaCache[key]
      documentMetaCache[key] = DocumentMeta(
        mimeType = current?.mimeType,
        displayName = current?.displayName,
        lastModified = modified,
      )
    }
  }

  private fun getMimeTypeForDocument(resolver: ContentResolver, uri: Uri): String? {
    documentMetaCache[uri.toString()]?.mimeType?.let { cachedMime ->
      if (cachedMime.isNotBlank()) {
        return cachedMime
      }
    }
    return runCatching {
      ensurePersistablePermission(resolver, uri)
      resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
        ?.use { cursor ->
          val idx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_MIME_TYPE)
          if (cursor.moveToFirst() && idx >= 0) {
            val mime = cursor.getString(idx)
            if (mime.isNullOrBlank()) {
              val nameIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
              val name = if (nameIdx >= 0) cursor.getString(nameIdx) ?: "" else ""
              guessMimeFromName(name)
            } else mime
          } else null
        }
    }.getOrNull()?.also { mime ->
      val key = uri.toString()
      val current = documentMetaCache[key]
      documentMetaCache[key] = DocumentMeta(
        mimeType = mime,
        displayName = current?.displayName,
        lastModified = current?.lastModified,
      )
    }
  }

  private fun ensurePersistablePermission(resolver: ContentResolver, uri: Uri) {
    runCatching {
      val takeFlags = android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or android.content.Intent.FLAG_GRANT_WRITE_URI_PERMISSION
      resolver.takePersistableUriPermission(uri, takeFlags)
    }
  }

  private fun isDirectoryByDocumentFile(uri: Uri): Boolean {
    return runCatching {
      val doc = DocumentFile.fromTreeUri(reactContext, uri) ?: DocumentFile.fromSingleUri(reactContext, uri)
      doc?.isDirectory == true
    }.getOrDefault(false)
  }

  private fun isPlaylistLikeEntry(mimeType: String?, displayName: String?): Boolean {
    val mime = (mimeType ?: "").lowercase(Locale.US)
    val name = (displayName ?: "").lowercase(Locale.US)
    if (name.endsWith(".m3u") || name.endsWith(".m3u8")) {
      return true
    }
    return mime.contains("mpegurl")
      || mime.contains("x-mpegurl")
      || mime.contains("vnd.apple.mpegurl")
      || mime == "application/vnd.apple.mpegurl"
      || mime == "audio/x-mpegurl"
  }

  private fun isAudioDocumentUri(uri: Uri): Boolean {
    val resolver = reactContext.contentResolver
    val displayName = getDisplayNameForDocument(resolver, uri)
    val mime = (getMimeTypeForDocument(resolver, uri) ?: guessMimeFromName(displayName.orEmpty()) ?: "").lowercase(Locale.US)
    if (!mime.startsWith("audio/")) {
      return false
    }
    return !isPlaylistLikeEntry(mime, displayName)
  }

  private fun getLibraryPathFromUri(uri: Uri): String {
    val source = URLDecoder.decode(uri.toString(), StandardCharsets.UTF_8.toString())
    val documentMarkerIndex = source.indexOf("/document/")
    val treeMarkerIndex = source.indexOf("/tree/")
    val docPart = when {
      documentMarkerIndex >= 0 -> source.substring(documentMarkerIndex + "/document/".length)
      treeMarkerIndex >= 0 -> source.substring(treeMarkerIndex + "/tree/".length)
      else -> source
    }
    val colonIndex = docPart.indexOf(':')
    val relativePath = if (colonIndex >= 0) docPart.substring(colonIndex + 1) else docPart
    return relativePath
      .replace('\\', '/')
      .replace(Regex("/+"), "/")
      .trim('/')
  }

  private fun getParentLibraryPath(path: String): String {
    val separatorIndex = path.lastIndexOf('/')
    if (separatorIndex <= 0) {
      return ""
    }
    return path.substring(0, separatorIndex)
  }

  private fun isPreferredArtworkFileName(displayName: String?): Boolean {
    val name = (displayName ?: "").lowercase(Locale.US)
    if (name.isBlank()) {
      return false
    }
    return name.contains("cover")
      || name.contains("folder")
      || name.contains("front")
      || name.contains("album")
      || name.contains("artwork")
  }

  private fun detectArtworkExtension(bytes: ByteArray): String {
    if (bytes.size >= 8
      && bytes[0] == 0x89.toByte()
      && bytes[1] == 0x50.toByte()
      && bytes[2] == 0x4E.toByte()
      && bytes[3] == 0x47.toByte()
    ) {
      return ".png"
    }
    if (bytes.size >= 2 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte()) {
      return ".jpg"
    }
    return ".jpg"
  }

  private fun md5Hex(bytes: ByteArray): String {
    val digest = MessageDigest.getInstance("MD5")
    val hashed = digest.digest(bytes)
    return hashed.joinToString("") { "%02x".format(it) }
  }

  private fun persistEmbeddedArtwork(uri: Uri, modified: Long, bytes: ByteArray): String? {
    return runCatching {
      val extension = detectArtworkExtension(bytes)
      val cacheDir = File(reactContext.cacheDir, "album-art")
      if (!cacheDir.exists()) {
        cacheDir.mkdirs()
      }
      val fileName = "${md5Hex(bytes)}$extension"
      val targetFile = File(cacheDir, fileName)
      if (!targetFile.exists() || targetFile.length() != bytes.size.toLong()) {
        FileOutputStream(targetFile).use { output ->
          output.write(bytes)
          output.flush()
        }
      }
      Uri.fromFile(targetFile).toString()
    }.getOrNull()
  }


  private fun extractMetadata(context: Context, uri: Uri): WritableMap {
    val map = Arguments.createMap()
    map.putString("uri", uri.toString())
    var title = ""
    var artist = ""
    var albumArtist = ""
    var album = ""
    var duration = ""
    var mimeType = ""
    var modified = 0L
    var displayName = ""
    var artworkUri = ""
    val folderPath = getParentLibraryPath(getLibraryPathFromUri(uri))
    val resolver = context.contentResolver
    runCatching {
      resolver.query(uri, arrayOf(
        android.provider.MediaStore.Audio.Media.TITLE,
        android.provider.MediaStore.Audio.Media.ARTIST,
        android.provider.MediaStore.Audio.Media.ALBUM,
        "album_artist",
        android.provider.MediaStore.Audio.Media.DURATION,
        android.provider.MediaStore.MediaColumns.MIME_TYPE,
        android.provider.MediaStore.MediaColumns.DATE_MODIFIED,
        android.provider.MediaStore.MediaColumns.DISPLAY_NAME,
      ), null, null, null)?.use { cursor ->
        val titleIdx = cursor.getColumnIndex(android.provider.MediaStore.Audio.Media.TITLE)
        val artistIdx = cursor.getColumnIndex(android.provider.MediaStore.Audio.Media.ARTIST)
        val albumIdx = cursor.getColumnIndex(android.provider.MediaStore.Audio.Media.ALBUM)
        val albumArtistIdx = cursor.getColumnIndex("album_artist")
        val durIdx = cursor.getColumnIndex(android.provider.MediaStore.Audio.Media.DURATION)
        val mimeIdx = cursor.getColumnIndex(android.provider.MediaStore.MediaColumns.MIME_TYPE)
        val modIdx = cursor.getColumnIndex(android.provider.MediaStore.MediaColumns.DATE_MODIFIED)
        val nameIdx = cursor.getColumnIndex(android.provider.MediaStore.MediaColumns.DISPLAY_NAME)
        if (cursor.moveToFirst()) {
          title = if (titleIdx >= 0) cursor.getString(titleIdx) ?: "" else ""
          artist = if (artistIdx >= 0) cursor.getString(artistIdx) ?: "" else ""
          album = if (albumIdx >= 0) cursor.getString(albumIdx) ?: "" else ""
          albumArtist = if (albumArtistIdx >= 0) cursor.getString(albumArtistIdx) ?: "" else ""
          duration = if (durIdx >= 0) cursor.getLong(durIdx).coerceAtLeast(0).toString() else ""
          mimeType = if (mimeIdx >= 0) cursor.getString(mimeIdx) ?: "" else ""
          modified = if (modIdx >= 0) cursor.getLong(modIdx).coerceAtLeast(0) else 0L
          displayName = if (nameIdx >= 0) cursor.getString(nameIdx) ?: "" else ""
        }
      }
    }
    if (title.isBlank() || duration.isBlank()) {
      runCatching {
        val retriever = MediaMetadataRetriever()
        retriever.setDataSource(context, uri)
        val metaTitle = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE).orEmpty()
        val metaArtist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST).orEmpty()
        val metaAlbumArtist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST).orEmpty()
        val metaAlbum = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM).orEmpty()
        val metaDuration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION).orEmpty()
        if (title.isBlank() && metaTitle.isNotBlank()) {
          title = metaTitle
        }
        if (artist.isBlank() && metaArtist.isNotBlank()) {
          artist = metaArtist
        }
        if (album.isBlank() && metaAlbum.isNotBlank()) {
          album = metaAlbum
        }
        if (albumArtist.isBlank() && metaAlbumArtist.isNotBlank()) {
          albumArtist = metaAlbumArtist
        }
        if (duration.isBlank() && metaDuration.isNotBlank()) {
          duration = metaDuration
        }
        if (artworkUri.isBlank() && shouldProbeEmbeddedArtwork(folderPath)) {
          val embedded = retriever.embeddedPicture
          if (embedded != null && embedded.isNotEmpty()) {
            artworkUri = persistEmbeddedArtwork(uri, modified, embedded).orEmpty()
            if (artworkUri.isNotBlank()) {
              markEmbeddedArtworkProbeResult(folderPath, true)
            } else {
              markEmbeddedArtworkProbeResult(folderPath, false)
            }
          } else {
            markEmbeddedArtworkProbeResult(folderPath, false)
          }
        }
        retriever.release()
      }.onFailure {
        markEmbeddedArtworkProbeResult(folderPath, false)
      }
    }
    if (title.isBlank()) {
      val fallbackName = (displayName.ifBlank {
        runCatching {
          resolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
            val nameIdx = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            if (cursor.moveToFirst() && nameIdx >= 0) cursor.getString(nameIdx) ?: "" else ""
          }
        }.getOrDefault("")
      } ?: "").toString()
      title = fallbackName.substringBeforeLast('.').ifBlank { fallbackName }.ifBlank { "Unbekannter Titel" }
    }
    if (mimeType.isBlank()) {
      mimeType = resolver.getType(uri).orEmpty()
    }
    map.putString("title", title)
    map.putString("artist", artist)
    map.putString("albumArtist", albumArtist.ifBlank { artist })
    map.putString("album", album)
    map.putString("durationMs", duration)
    map.putString("mimeType", mimeType)
    map.putString("sourceLastModified", modified.toString())
    map.putString("artworkUri", artworkUri)
    return map
  }

  private fun shouldProbeEmbeddedArtwork(folderPath: String): Boolean {
    if (folderPath.isBlank()) {
      return true
    }
    return folderEmbeddedArtworkProbeState[folderPath] != false
  }

  private fun markEmbeddedArtworkProbeResult(folderPath: String, hasArtwork: Boolean) {
    if (folderPath.isBlank()) {
      return
    }
    if (hasArtwork) {
      folderEmbeddedArtworkProbeState[folderPath] = true
      return
    }
    if (!folderEmbeddedArtworkProbeState.containsKey(folderPath)) {
      folderEmbeddedArtworkProbeState[folderPath] = false
    }
  }
}
