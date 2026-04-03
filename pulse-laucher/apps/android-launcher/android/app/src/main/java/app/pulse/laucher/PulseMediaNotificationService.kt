package app.pulse.laucher

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle

class PulseMediaNotificationService : Service() {

  private var title: String = "Aurora Pulse"
  private var artist: String = "Bereit"
  private var album: String = "Aurora Pulse"
  private var artworkUri: String = ""
  private var queueIndex: Int = 0
  private var queueSize: Int = 1
  private var isPlaying: Boolean = false
  private var profileName: String = ""
  private var lastAppliedNotificationSignature: String = ""
  private var lastAppliedNotificationAtMs: Long = 0L
  private val minNotificationUpdateIntervalMs: Long = 1200L
  private var artworkCacheUri: String = ""
  private var artworkCacheBitmap: Bitmap? = null
  private var fallbackIconBitmap: Bitmap? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      lastAppliedNotificationSignature = ""
      lastAppliedNotificationAtMs = 0L
      stopSelf()
      return START_NOT_STICKY
    }
    title = intent?.getStringExtra(EXTRA_TITLE)?.ifBlank { title } ?: title
    artist = intent?.getStringExtra(EXTRA_ARTIST)?.ifBlank { artist } ?: artist
    album = intent?.getStringExtra(EXTRA_ALBUM)?.ifBlank { album } ?: album
    artworkUri = intent?.getStringExtra(EXTRA_ARTWORK_URI) ?: artworkUri
    queueIndex = (intent?.getIntExtra(EXTRA_QUEUE_INDEX, queueIndex) ?: queueIndex).coerceAtLeast(0)
    queueSize = (intent?.getIntExtra(EXTRA_QUEUE_SIZE, queueSize) ?: queueSize).coerceAtLeast(1)
    isPlaying = intent?.getBooleanExtra(EXTRA_IS_PLAYING, isPlaying) ?: isPlaying
    profileName = intent?.getStringExtra(EXTRA_PROFILE_NAME) ?: profileName
    val notificationSignature = buildString {
      append(title)
      append('\u0000')
      append(artist)
      append('\u0000')
      append(album)
      append('\u0000')
      append(artworkUri)
      append('\u0000')
      append(queueIndex)
      append('/')
      append(queueSize)
      append('\u0000')
      append(isPlaying)
      append('\u0000')
      append(profileName)
    }
    val nowMs = SystemClock.elapsedRealtime()
    val shouldSkipUpdate = notificationSignature == lastAppliedNotificationSignature
      && (nowMs - lastAppliedNotificationAtMs) < minNotificationUpdateIntervalMs
    if (shouldSkipUpdate) {
      return START_STICKY
    }
    startForeground(NOTIFICATION_ID, buildNotification())
    lastAppliedNotificationSignature = notificationSignature
    lastAppliedNotificationAtMs = nowMs
    return START_STICKY
  }

  private fun buildNotification(): Notification {
    ensureChannel()
    val compactSubtitle = buildString {
      append("${queueIndex + 1}/$queueSize")
      if (profileName.isNotBlank()) {
        append(" · EQ: ")
        append(profileName)
      }
    }
    val previousIntent = PendingIntent.getBroadcast(
      this,
      1001,
      Intent(this, PulseMediaActionReceiver::class.java).setAction(PulseMediaActionReceiver.ACTION_PREVIOUS),
      pendingIntentFlags(),
    )
    val playPauseIntent = PendingIntent.getBroadcast(
      this,
      1002,
      Intent(this, PulseMediaActionReceiver::class.java).setAction(PulseMediaActionReceiver.ACTION_PLAY_PAUSE),
      pendingIntentFlags(),
    )
    val nextIntent = PendingIntent.getBroadcast(
      this,
      1003,
      Intent(this, PulseMediaActionReceiver::class.java).setAction(PulseMediaActionReceiver.ACTION_NEXT),
      pendingIntentFlags(),
    )
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = PendingIntent.getActivity(
      this,
      1004,
      launchIntent ?: Intent(),
      pendingIntentFlags(),
    )
    val mediaStyle = MediaStyle()
      .setShowActionsInCompactView(0, 1, 2)
    PulseMediaSessionBridge.sessionToken?.let { token ->
      mediaStyle.setMediaSession(token)
    }
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_pulse_media)
      .setContentTitle(title)
      .setContentText(artist.ifBlank { album })
      .setSubText(compactSubtitle)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setStyle(mediaStyle)
      .setContentIntent(contentIntent)
      .setColor(0xFF5EA8FF.toInt())
      .addAction(R.drawable.ic_notif_prev, "Zurück", previousIntent)
      .addAction(
        if (isPlaying) R.drawable.ic_notif_pause else R.drawable.ic_notif_play,
        if (isPlaying) "Pause" else "Abspielen",
        playPauseIntent,
      )
      .addAction(R.drawable.ic_notif_next, "Weiter", nextIntent)
    decodeArtworkBitmap(artworkUri)?.let { artwork ->
      builder.setLargeIcon(artwork)
    }
    return builder.build()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val notificationManager = getSystemService(NotificationManager::class.java)
    if (notificationManager.getNotificationChannel(CHANNEL_ID) != null) {
      return
    }
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Pulse Media",
      NotificationManager.IMPORTANCE_LOW,
    )
    channel.description = "Lockscreen Mediensteuerung"
    channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    channel.setShowBadge(false)
    channel.setSound(null, null)
    notificationManager.createNotificationChannel(channel)
  }

  private fun decodeArtworkBitmap(uri: String): Bitmap? {
    if (uri.isNotBlank() && uri == artworkCacheUri && artworkCacheBitmap != null) {
      return artworkCacheBitmap
    }
    val resolved = if (uri.isBlank()) {
      null
    } else {
      runCatching {
        when {
          uri.startsWith("content://", ignoreCase = true) || uri.startsWith("file://", ignoreCase = true) -> {
            contentResolver.openInputStream(Uri.parse(uri))?.use { input ->
              BitmapFactory.decodeStream(input)
            }
          }
          else -> null
        }
      }.getOrNull()
    }
    if (resolved != null) {
      artworkCacheUri = uri
      artworkCacheBitmap = resolved
      return resolved
    }
    if (fallbackIconBitmap == null) {
      fallbackIconBitmap = drawableToBitmap(applicationInfo.loadIcon(packageManager))
    }
    return fallbackIconBitmap
  }

  private fun drawableToBitmap(drawable: Drawable): Bitmap {
    if (drawable is BitmapDrawable && drawable.bitmap != null) {
      return drawable.bitmap
    }
    val width = if (drawable.intrinsicWidth > 0) drawable.intrinsicWidth else 128
    val height = if (drawable.intrinsicHeight > 0) drawable.intrinsicHeight else 128
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    drawable.setBounds(0, 0, canvas.width, canvas.height)
    drawable.draw(canvas)
    return bitmap
  }

  private fun pendingIntentFlags(): Int {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    } else {
      PendingIntent.FLAG_UPDATE_CURRENT
    }
  }

  companion object {
    private const val CHANNEL_ID = "pulse_media_playback"
    private const val NOTIFICATION_ID = 7391
    private const val ACTION_UPDATE = "app.pulse.laucher.MEDIA_NOTIFICATION_UPDATE"
    private const val ACTION_STOP = "app.pulse.laucher.MEDIA_NOTIFICATION_STOP"
    private const val EXTRA_TITLE = "title"
    private const val EXTRA_ARTIST = "artist"
    private const val EXTRA_ALBUM = "album"
    private const val EXTRA_ARTWORK_URI = "artworkUri"
    private const val EXTRA_QUEUE_INDEX = "queueIndex"
    private const val EXTRA_QUEUE_SIZE = "queueSize"
    private const val EXTRA_IS_PLAYING = "isPlaying"
    private const val EXTRA_PROFILE_NAME = "profileName"

    fun startOrUpdate(
      context: android.content.Context,
      title: String,
      artist: String,
      album: String,
      artworkUri: String,
      queueIndex: Int,
      queueSize: Int,
      isPlaying: Boolean,
      profileName: String,
    ) {
      val intent = Intent(context, PulseMediaNotificationService::class.java).apply {
        action = ACTION_UPDATE
        putExtra(EXTRA_TITLE, title)
        putExtra(EXTRA_ARTIST, artist)
        putExtra(EXTRA_ALBUM, album)
        putExtra(EXTRA_ARTWORK_URI, artworkUri)
        putExtra(EXTRA_QUEUE_INDEX, queueIndex)
        putExtra(EXTRA_QUEUE_SIZE, queueSize)
        putExtra(EXTRA_IS_PLAYING, isPlaying)
        putExtra(EXTRA_PROFILE_NAME, profileName)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: android.content.Context) {
      val intent = Intent(context, PulseMediaNotificationService::class.java).apply {
        action = ACTION_STOP
      }
      context.startService(intent)
    }
  }
}
