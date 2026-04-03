package app.pulse.laucher

import android.content.ContentResolver
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract

/**
 * [DocumentsContract.refresh] (API 29+) is not always visible to the Kotlin compiler against older SDK stubs.
 */
object DocumentTreeRefresh {
  fun refreshResolver(resolver: ContentResolver, documentUri: Uri): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return false
    }
    return runCatching {
      val method = DocumentsContract::class.java.getMethod(
        "refresh",
        ContentResolver::class.java,
        Uri::class.java,
        Bundle::class.java,
      )
      java.lang.Boolean.TRUE == method.invoke(null, resolver, documentUri, null)
    }.getOrDefault(false)
  }
}
