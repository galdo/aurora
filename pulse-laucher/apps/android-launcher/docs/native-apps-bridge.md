# Native Apps Bridge

## Ziel

Die Apps-Ansicht soll installierte Android-Apps auslesen und direkt starten.

## JS-Vertrag

Der Launcher erwartet ein Native Module `PulseLauncherAppsModule` mit:

- `getInstalledApps(): Promise<{ appName: string; packageName: string }[]>`
- `launchApp(packageName: string): Promise<boolean>`

Der Launcher erwartet zusätzlich `PulseMediaLibraryModule` mit:

- `getSections(route: string): Promise<{ id: string; title: string; items: { id: string; title: string; subtitle: string; meta?: string }[] }[]>`
- `getPinnedItems(): Promise<string[]>`
- `getPinnedRecords(): Promise<{ collection_item_id: string; collection_item_type: string; order: number; pinned_at: number; title: string }[]>`
- `togglePinnedItem(itemId: string, itemType: string, title: string): Promise<boolean>`
- `updatePinnedOrder(orderedKeys: string[]): Promise<boolean>`
- `getPodcastUpdates(): Promise<number>`

## Kotlin Referenz

```kotlin
package app.pulse.laucher

import android.content.Intent
import android.content.pm.PackageManager
import com.facebook.react.bridge.*

class PulseLauncherAppsModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "PulseLauncherAppsModule"

  @ReactMethod
  fun getInstalledApps(promise: Promise) {
    val packageManager = reactContext.packageManager
    val launchIntent = Intent(Intent.ACTION_MAIN, null).apply {
      addCategory(Intent.CATEGORY_LAUNCHER)
    }
    val apps = packageManager.queryIntentActivities(launchIntent, 0)
    val result = Arguments.createArray()
    apps.forEach { resolveInfo ->
      val map = Arguments.createMap()
      map.putString("appName", resolveInfo.loadLabel(packageManager).toString())
      map.putString("packageName", resolveInfo.activityInfo.packageName)
      result.pushMap(map)
    }
    promise.resolve(result)
  }

  @ReactMethod
  fun launchApp(packageName: String, promise: Promise) {
    val packageManager = reactContext.packageManager
    val intent = packageManager.getLaunchIntentForPackage(packageName)
    if (intent == null) {
      promise.resolve(false)
      return
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    reactContext.startActivity(intent)
    promise.resolve(true)
  }
}
```

## Einbauhinweis

- Für Expo wird ein Prebuild mit Custom Native Module benötigt.
- Für Bare React Native wird das Modul regulär über Package + Module-Registry eingebunden.
