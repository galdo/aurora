package app.pulse.laucher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.provider.DocumentsContract
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.FileOutputStream
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Locale

data class LibrarySyncStatus(
  val running: Boolean = false,
  val stage: String = "idle",
  val total: Int = 0,
  val processed: Int = 0,
  val changed: Int = 0,
  val cached: Int = 0,
  val rootKey: String = "",
  val lastError: String = "",
)

data class LibraryTrackRecord(
  val uri: String,
  val rootKey: String,
  val folderPath: String,
  val title: String,
  val artist: String,
  val albumArtist: String,
  val album: String,
  val trackNumber: Int,
  val durationMs: Long,
  val mimeType: String,
  val lastModified: Long,
  val artworkUri: String,
)

private data class ScannedEntry(
  val uri: String,
  val displayName: String,
  val mimeType: String,
  val lastModified: Long,
  val folderPath: String,
)

class LibraryIndexDatabase private constructor(context: Context) :
  SQLiteOpenHelper(context.applicationContext, "library_index.db", null, 2) {

  companion object {
    @Volatile private var instance: LibraryIndexDatabase? = null
    fun getInstance(context: Context): LibraryIndexDatabase {
      return instance ?: synchronized(this) {
        instance ?: LibraryIndexDatabase(context).also { instance = it }
      }
    }
  }

  override fun onConfigure(db: SQLiteDatabase) {
    super.onConfigure(db)
    db.enableWriteAheadLogging()
  }

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      """
      CREATE TABLE IF NOT EXISTS tracks (
        uri TEXT PRIMARY KEY NOT NULL,
        root_key TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album_artist TEXT NOT NULL,
        album TEXT NOT NULL,
        track_number INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        last_modified INTEGER NOT NULL,
        artwork_uri TEXT NOT NULL
      )
      """.trimIndent(),
    )
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_tracks_root ON tracks(root_key)")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album)")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist)")
    db.execSQL("CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder_path)")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    if (oldVersion < 2) {
      db.execSQL("DROP TABLE IF EXISTS tracks")
      onCreate(db)
    }
  }

  fun getLastModifiedByUri(rootKey: String): Map<String, Long> {
    val db = readableDatabase
    val result = HashMap<String, Long>()
    db.rawQuery("SELECT uri, last_modified FROM tracks WHERE root_key = ?", arrayOf(rootKey)).use { cursor ->
      val uriIndex = cursor.getColumnIndex("uri")
      val modifiedIndex = cursor.getColumnIndex("last_modified")
      while (cursor.moveToNext()) {
        result[cursor.getString(uriIndex)] = cursor.getLong(modifiedIndex)
      }
    }
    return result
  }

  fun upsertBatch(records: List<LibraryTrackRecord>) {
    if (records.isEmpty()) return
    val db = writableDatabase
    db.beginTransactionNonExclusive()
    try {
      val stmt = db.compileStatement(
        """
          INSERT OR REPLACE INTO tracks
          (uri, root_key, folder_path, title, artist, album_artist, album, track_number, duration_ms, mime_type, last_modified, artwork_uri)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """.trimIndent(),
      )
      records.forEach { row ->
        stmt.clearBindings()
        stmt.bindString(1, row.uri)
        stmt.bindString(2, row.rootKey)
        stmt.bindString(3, row.folderPath)
        stmt.bindString(4, row.title)
        stmt.bindString(5, row.artist)
        stmt.bindString(6, row.albumArtist)
        stmt.bindString(7, row.album)
        stmt.bindLong(8, row.trackNumber.toLong())
        stmt.bindLong(9, row.durationMs)
        stmt.bindString(10, row.mimeType)
        stmt.bindLong(11, row.lastModified)
        stmt.bindString(12, row.artworkUri)
        stmt.executeInsert()
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun deleteMissingUris(rootKey: String, keepUris: Set<String>) {
    val db = writableDatabase
    if (keepUris.isEmpty()) {
      db.execSQL("DELETE FROM tracks WHERE root_key = ?", arrayOf(rootKey))
      return
    }
    val batchSize = 700
    val chunks = keepUris.toList().chunked(batchSize)
    db.beginTransactionNonExclusive()
    try {
      db.execSQL("DELETE FROM tracks WHERE root_key = ?", arrayOf(rootKey))
      val insertStmt = db.compileStatement(
        """
        INSERT OR IGNORE INTO tracks
        (uri, root_key, folder_path, title, artist, album, track_number, duration_ms, mime_type, last_modified, artwork_uri)
        SELECT uri, root_key, folder_path, title, artist, album, track_number, duration_ms, mime_type, last_modified, artwork_uri
        FROM tracks_backup WHERE uri = ?
        """.trimIndent()
      )
      insertStmt.close()
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun queryAllForRoot(rootKey: String): List<LibraryTrackRecord> {
    val db = readableDatabase
    val rows = ArrayList<LibraryTrackRecord>()
    db.rawQuery(
      "SELECT uri, root_key, folder_path, title, artist, album_artist, album, track_number, duration_ms, mime_type, last_modified, artwork_uri FROM tracks WHERE root_key = ? ORDER BY album COLLATE NOCASE, track_number ASC, title COLLATE NOCASE",
      arrayOf(rootKey),
    ).use { cursor ->
      while (cursor.moveToNext()) {
        rows.add(
          LibraryTrackRecord(
            uri = cursor.getString(0),
            rootKey = cursor.getString(1),
            folderPath = cursor.getString(2),
            title = cursor.getString(3),
            artist = cursor.getString(4),
            albumArtist = cursor.getString(5),
            album = cursor.getString(6),
            trackNumber = cursor.getInt(7),
            durationMs = cursor.getLong(8),
            mimeType = cursor.getString(9),
            lastModified = cursor.getLong(10),
            artworkUri = cursor.getString(11),
          ),
        )
      }
    }
    return rows
  }

  fun replaceForRoot(rootKey: String, rows: List<LibraryTrackRecord>) {
    val db = writableDatabase
    db.beginTransactionNonExclusive()
    try {
      db.execSQL("DELETE FROM tracks WHERE root_key = ?", arrayOf(rootKey))
      val stmt = db.compileStatement(
        """
          INSERT OR REPLACE INTO tracks
          (uri, root_key, folder_path, title, artist, album_artist, album, track_number, duration_ms, mime_type, last_modified, artwork_uri)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """.trimIndent(),
      )
      rows.forEach { row ->
        stmt.clearBindings()
        stmt.bindString(1, row.uri)
        stmt.bindString(2, row.rootKey)
        stmt.bindString(3, row.folderPath)
        stmt.bindString(4, row.title)
        stmt.bindString(5, row.artist)
        stmt.bindString(6, row.albumArtist)
        stmt.bindString(7, row.album)
        stmt.bindLong(8, row.trackNumber.toLong())
        stmt.bindLong(9, row.durationMs)
        stmt.bindString(10, row.mimeType)
        stmt.bindLong(11, row.lastModified)
        stmt.bindString(12, row.artworkUri)
        stmt.executeInsert()
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }
}

object LibrarySyncCoordinator {
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val mutex = Mutex()
  @Volatile private var status = LibrarySyncStatus()
  @Volatile private var currentJob: Job? = null

  fun getStatus(): LibrarySyncStatus = status

  suspend fun startSync(context: Context, roots: List<String>) {
    mutex.withLock {
      val rootKey = roots.map { it.trim() }.filter { it.isNotEmpty() }.sorted().joinToString("|")
      if (rootKey.isBlank()) {
        status = LibrarySyncStatus(running = false, stage = "idle")
        return
      }
      val runningJob = currentJob
      if (runningJob?.isActive == true && status.running && status.rootKey == rootKey) {
        return
      }
      runningJob?.cancel()
      val db = LibraryIndexDatabase.getInstance(context)
      currentJob = scope.launch {
        val resolver = context.contentResolver
        runCatching {
          status = LibrarySyncStatus(running = true, stage = "scan", rootKey = rootKey)
          val scanResult = scanAudioEntries(resolver, roots)
          val scannedEntries = scanResult.entries
          val existing = db.getLastModifiedByUri(rootKey)
          val changedEntries = scannedEntries.filter { entry -> existing[entry.uri] != entry.lastModified }
          status = status.copy(stage = "parse", total = scannedEntries.size, changed = changedEntries.size, cached = scannedEntries.size - changedEntries.size)
          val parseChunkSize = when {
            changedEntries.size >= 6000 -> 24
            changedEntries.size >= 3000 -> 32
            changedEntries.size >= 1500 -> 48
            else -> 64
          }
          val parsePauseMs = if (changedEntries.size >= 3000) 3L else 1L
          val folderArtworkResolved = HashMap(scanResult.folderArtworkByFolderPath)
          val changedByUri = HashMap<String, LibraryTrackRecord>()
          changedEntries.chunked(parseChunkSize).forEach { chunk ->
            val parsed = chunk.mapNotNull { entry ->
              parseTrack(context, rootKey, entry, folderArtworkResolved)
            }
            parsed.forEach { changedByUri[it.uri] = it }
            status = status.copy(processed = (status.processed + chunk.size).coerceAtMost(changedEntries.size))
            delay(parsePauseMs)
          }
          val existingRows = db.queryAllForRoot(rootKey).associateBy { it.uri }
          val mergedRows = scannedEntries.mapNotNull { entry ->
            changedByUri[entry.uri] ?: existingRows[entry.uri] ?: parseTrack(context, rootKey, entry, folderArtworkResolved)
          }.map { row ->
            if (row.artworkUri.isNotBlank()) {
              row
            } else {
              val fallbackArtwork = resolveFolderArtwork(row.folderPath, folderArtworkResolved)
              if (fallbackArtwork.isNotBlank()) row.copy(artworkUri = fallbackArtwork) else row
            }
          }
          status = status.copy(stage = "persist")
          db.replaceForRoot(rootKey, mergedRows)
          status = LibrarySyncStatus(running = false, stage = "done", total = scannedEntries.size, processed = changedEntries.size, changed = changedEntries.size, cached = scannedEntries.size - changedEntries.size, rootKey = rootKey)
        }.onFailure { error ->
          if (error is CancellationException) {
            status = status.copy(running = false, stage = "cancelled", lastError = "")
            return@onFailure
          }
          status = status.copy(running = false, stage = "failed", lastError = error.message ?: "sync-error")
        }
      }
    }
  }

  fun cancel() {
    currentJob?.cancel()
    status = status.copy(running = false, stage = "cancelled")
  }

  private data class ScanBundle(
    val entries: List<ScannedEntry>,
    val folderArtworkByFolderPath: Map<String, String>,
  )

  /**
   * After copying files to SD/USB, many providers serve stale children until the tree is refreshed (API 29+).
   */
  private fun refreshDocumentRoots(resolver: ContentResolver, roots: List<String>) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return
    }
    roots.forEach { root ->
      runCatching {
        val rootUri = Uri.parse(root)
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

  private fun scanAudioEntries(resolver: ContentResolver, roots: List<String>): ScanBundle {
    refreshDocumentRoots(resolver, roots)
    val result = ArrayList<ScannedEntry>()
    val folderArtworkByFolderPath = HashMap<String, String>()
    val queue = ArrayDeque<Pair<Uri, String>>()
    val seen = HashSet<String>()
    roots.forEach { root ->
      val rootUri = Uri.parse(root)
      val treeUri = if (DocumentsContract.isTreeUri(rootUri)) rootUri else DocumentsContract.buildTreeDocumentUri(rootUri.authority, DocumentsContract.getDocumentId(rootUri))
      val rootDocId = if (DocumentsContract.isTreeUri(rootUri)) DocumentsContract.getTreeDocumentId(rootUri) else DocumentsContract.getDocumentId(rootUri)
      queue.addLast(treeUri to rootDocId)
    }
    while (queue.isNotEmpty() && result.size < 40000) {
      val (treeUri, parentDocId) = queue.removeFirst()
      val key = "${treeUri}#${parentDocId}"
      if (!seen.add(key)) continue
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
        while (cursor.moveToNext() && result.size < 40000) {
          val childDocId = cursor.getString(idIndex) ?: continue
          val name = (if (nameIndex >= 0) cursor.getString(nameIndex) else "").orEmpty()
          val rawMime = (if (mimeIndex >= 0) cursor.getString(mimeIndex) else "").orEmpty().lowercase(Locale.US)
          val flags = if (flagsIndex >= 0) cursor.getInt(flagsIndex) else 0
          val isDirectory = rawMime == DocumentsContract.Document.MIME_TYPE_DIR.lowercase(Locale.US)
            || (flags and DocumentsContract.Document.FLAG_DIR_SUPPORTS_CREATE) != 0
          if (isDirectory) {
            queue.addLast(treeUri to childDocId)
            continue
          }
          val mime = if (rawMime.isBlank() || rawMime == "application/octet-stream") {
            guessMimeFromName(name).orEmpty().lowercase(Locale.US)
          } else {
            rawMime
          }
          val lastModified = if (modIndex >= 0) cursor.getLong(modIndex) else 0L
          val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, childDocId)
          val uriText = docUri.toString()
          val libraryPath = getLibraryPathFromUri(uriText)
          val folderPath = getParentLibraryPath(libraryPath)
          val albumFolderPath = normalizeAlbumFolderPath(folderPath)
          if (mime.startsWith("image/")) {
            if (albumFolderPath.isNotBlank() && (folderArtworkByFolderPath[albumFolderPath] == null || isPreferredArtworkFileName(name))) {
              folderArtworkByFolderPath[albumFolderPath] = uriText
            }
            continue
          }
          if (!mime.startsWith("audio/")) continue
          val lowerName = name.lowercase(Locale.US)
          if (lowerName.endsWith(".m3u") || lowerName.endsWith(".m3u8")) continue
          result.add(
            ScannedEntry(
              uri = uriText,
              displayName = name,
              mimeType = mime,
              lastModified = lastModified,
              folderPath = folderPath,
            ),
          )
        }
      }
    }
    return ScanBundle(entries = result, folderArtworkByFolderPath = folderArtworkByFolderPath)
  }

  private fun parseTrack(
    context: Context,
    rootKey: String,
    entry: ScannedEntry,
    folderArtworkByFolderPath: MutableMap<String, String>,
  ): LibraryTrackRecord? {
    var title = entry.displayName.substringBeforeLast('.')
    var artist = ""
    var albumArtist = ""
    var album = ""
    var durationMs = 0L
    var track = 0
    var artworkUri = resolveFolderArtwork(entry.folderPath, folderArtworkByFolderPath)
    runCatching {
      context.contentResolver.query(
        Uri.parse(entry.uri),
        arrayOf(
          android.provider.MediaStore.Audio.Media.TITLE,
          android.provider.MediaStore.Audio.Media.ARTIST,
          android.provider.MediaStore.Audio.Media.ALBUM,
          "album_artist",
          android.provider.MediaStore.Audio.Media.DURATION,
          android.provider.MediaStore.Audio.Media.TRACK,
        ),
        null,
        null,
        null,
      )?.use { cursor ->
        if (cursor.moveToFirst()) {
          val titleIdx = cursor.getColumnIndex(android.provider.MediaStore.Audio.Media.TITLE)
          val artistIdx = cursor.getColumnIndex(android.provider.MediaStore.Audio.Media.ARTIST)
          val albumIdx = cursor.getColumnIndex(android.provider.MediaStore.Audio.Media.ALBUM)
          val albumArtistIdx = cursor.getColumnIndex("album_artist")
          val durationIdx = cursor.getColumnIndex(android.provider.MediaStore.Audio.Media.DURATION)
          val trackIdx = cursor.getColumnIndex(android.provider.MediaStore.Audio.Media.TRACK)
          if (title.isBlank() && titleIdx >= 0) {
            title = cursor.getString(titleIdx).orEmpty().ifBlank { title }
          }
          if (artist.isBlank() && artistIdx >= 0) {
            artist = cursor.getString(artistIdx).orEmpty()
          }
          if (album.isBlank() && albumIdx >= 0) {
            album = cursor.getString(albumIdx).orEmpty()
          }
          if (albumArtist.isBlank() && albumArtistIdx >= 0) {
            albumArtist = cursor.getString(albumArtistIdx).orEmpty()
          }
          if (durationMs <= 0L && durationIdx >= 0) {
            durationMs = cursor.getLong(durationIdx).coerceAtLeast(0L)
          }
          if (track <= 0 && trackIdx >= 0) {
            track = cursor.getInt(trackIdx).coerceAtLeast(0)
          }
        }
      }
    }
    runCatching {
      val retriever = MediaMetadataRetriever()
      try {
        retriever.setDataSource(context, Uri.parse(entry.uri))
        title = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE).orEmpty().ifBlank { title }
        artist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST).orEmpty().ifBlank { artist }
        albumArtist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST).orEmpty().ifBlank { albumArtist }
        album = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM).orEmpty().ifBlank { album }
        val metadataDuration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        if (durationMs <= 0L && metadataDuration > 0L) {
          durationMs = metadataDuration
        }
        val metadataTrack = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER)?.substringBefore("/")?.toIntOrNull() ?: 0
        if (track <= 0 && metadataTrack > 0) {
          track = metadataTrack
        }
        val embedded = retriever.embeddedPicture
        if (embedded != null && embedded.isNotEmpty()) {
          val persisted = persistEmbeddedArtwork(context, entry.uri, entry.lastModified, embedded).orEmpty()
          if (persisted.isNotBlank()) {
            artworkUri = persisted
          }
        }
      } finally {
        retriever.release()
      }
    }
    return LibraryTrackRecord(
      uri = entry.uri,
      rootKey = rootKey,
      folderPath = entry.folderPath,
      title = title.ifBlank { "Unbekannter Titel" },
      artist = artist,
      albumArtist = albumArtist.ifBlank { artist },
      album = album,
      trackNumber = track,
      durationMs = durationMs,
      mimeType = entry.mimeType,
      lastModified = entry.lastModified,
      artworkUri = artworkUri,
    )
  }

  private fun resolveFolderArtwork(folderPath: String, artworkMap: Map<String, String>): String {
    val direct = artworkMap[folderPath]
    if (!direct.isNullOrBlank()) return direct
    val normalizedAlbumFolder = normalizeAlbumFolderPath(folderPath)
    return artworkMap[normalizedAlbumFolder].orEmpty()
  }

  private fun normalizeAlbumFolderPath(folderPath: String): String {
    if (folderPath.isBlank()) return folderPath
    val segments = folderPath.split('/').filter { it.isNotBlank() }
    if (segments.isEmpty()) return folderPath
    val last = segments.last()
    val isDiscFolder = Regex("^(?:cd|disc)\\s*0*\\d+\$", RegexOption.IGNORE_CASE).matches(last)
    return if (isDiscFolder && segments.size > 1) segments.dropLast(1).joinToString("/") else segments.joinToString("/")
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

  private fun persistEmbeddedArtwork(context: Context, uri: String, modified: Long, bytes: ByteArray): String? {
    return runCatching {
      val extension = detectArtworkExtension(bytes)
      val cacheDir = File(context.cacheDir, "album-art")
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

  private fun getLibraryPathFromUri(uri: String): String {
    val source = URLDecoder.decode(uri, StandardCharsets.UTF_8.toString())
    val documentMarkerIndex = source.indexOf("/document/")
    val treeMarkerIndex = source.indexOf("/tree/")
    val docPart = when {
      documentMarkerIndex >= 0 -> source.substring(documentMarkerIndex + "/document/".length)
      treeMarkerIndex >= 0 -> source.substring(treeMarkerIndex + "/tree/".length)
      else -> source
    }
    val colonIndex = docPart.indexOf(':')
    val relativePath = if (colonIndex >= 0) docPart.substring(colonIndex + 1) else docPart
    return relativePath.replace('\\', '/').replace(Regex("/+"), "/").trim('/')
  }

  private fun getParentLibraryPath(path: String): String {
    val separatorIndex = path.lastIndexOf('/')
    if (separatorIndex <= 0) return ""
    return path.substring(0, separatorIndex)
  }

  private fun isPreferredArtworkFileName(name: String): Boolean {
    val lower = name.lowercase(Locale.US)
    return lower.contains("cover") || lower.contains("folder") || lower.contains("front") || lower.contains("album")
  }

  private fun guessMimeFromName(name: String): String? {
    val lower = name.lowercase(Locale.US)
    return when {
      lower.endsWith(".flac") -> "audio/flac"
      lower.endsWith(".mp3") -> "audio/mpeg"
      lower.endsWith(".m4a") -> "audio/mp4"
      lower.endsWith(".aac") -> "audio/aac"
      lower.endsWith(".wav") -> "audio/wav"
      lower.endsWith(".ogg") -> "audio/ogg"
      lower.endsWith(".opus") -> "audio/ogg"
      lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
      lower.endsWith(".png") -> "image/png"
      lower.endsWith(".webp") -> "image/webp"
      else -> null
    }
  }
}

class LibrarySyncService : Service() {
  companion object {
    const val ACTION_START = "app.pulse.laucher.LIBRARY_SYNC_START"
    const val ACTION_CANCEL = "app.pulse.laucher.LIBRARY_SYNC_CANCEL"
    const val EXTRA_ROOT_URIS = "rootUris"
    private const val CHANNEL_ID = "library_sync_channel"
    private const val NOTIFICATION_ID = 5012
  }

  private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

  override fun onCreate() {
    super.onCreate()
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_CANCEL -> {
        LibrarySyncCoordinator.cancel()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
      ACTION_START -> {
        startForeground(NOTIFICATION_ID, buildNotification("Bibliothek wird eingelesen…"))
        val roots = intent.getStringArrayListExtra(EXTRA_ROOT_URIS)?.toList() ?: emptyList()
        serviceScope.launch {
          LibrarySyncCoordinator.startSync(applicationContext, roots)
          while (LibrarySyncCoordinator.getStatus().running) {
            val state = LibrarySyncCoordinator.getStatus()
            val text = when (state.stage) {
              "scan" -> "Dateien werden gefunden…"
              "parse" -> "Metadaten: ${state.processed}/${state.changed}"
              "persist" -> "Datenbank wird aktualisiert…"
              else -> "Bibliothek wird eingelesen…"
            }
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.notify(NOTIFICATION_ID, buildNotification(text))
            delay(400)
          }
          stopForeground(STOP_FOREGROUND_REMOVE)
          stopSelf()
        }
      }
    }
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    serviceScope.cancel()
    super.onDestroy()
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = NotificationChannel(CHANNEL_ID, "Library Sync", NotificationManager.IMPORTANCE_LOW)
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(text: String): Notification {
    val openIntent = Intent(this, MainActivity::class.java)
    val pendingIntent = PendingIntent.getActivity(
      this,
      0,
      openIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle("Aurora Pulse")
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(pendingIntent)
      .build()
  }
}

fun LibrarySyncStatus.toWritableMap(): WritableMap {
  val map = Arguments.createMap()
  map.putBoolean("running", running)
  map.putString("stage", stage)
  map.putInt("total", total)
  map.putInt("processed", processed)
  map.putInt("changed", changed)
  map.putInt("cached", cached)
  map.putString("rootKey", rootKey)
  map.putString("lastError", lastError)
  return map
}
