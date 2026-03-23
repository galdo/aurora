package app.pulse.laucher.dlna

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

class PulseDLNAControlModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    init {
        PulseDLNAControlBridge.attach(this)
    }

    override fun getName(): String = "PulseDLNAControlModule"

    @ReactMethod
    fun addListener(_eventName: String) {
    }

    @ReactMethod
    fun removeListeners(_count: Int) {
    }

    @ReactMethod
    fun updatePlaybackState(state: String, positionMs: Double, durationMs: Double, promise: Promise) {
        PulseMediaRendererService.instance?.updatePlaybackState(state, positionMs.toLong(), durationMs.toLong())
        promise.resolve(true)
    }

    @ReactMethod
    fun updatePlaybackTrack(
        uri: String,
        title: String,
        artist: String,
        albumArt: String,
        queueIndex: Double,
        queueSize: Double,
        promise: Promise,
    ) {
        PulseMediaRendererService.instance?.updatePlaybackTrack(
            uri = uri,
            title = title,
            artist = artist,
            albumArt = albumArt,
            queueIndex = queueIndex.toInt(),
            queueSize = queueSize.toInt(),
        )
        promise.resolve(true)
    }

    fun emitEvent(eventName: String, payload: WritableMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(eventName, payload)
    }

    override fun invalidate() {
        PulseDLNAControlBridge.detach(this)
        super.invalidate()
    }
}
