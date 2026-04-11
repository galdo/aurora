/**
 * Stable string codes for DLNA **control** (renderer SOAP) failures.
 * Use in logs and `DlnaControlError` for grep-friendly diagnosis.
 */
export enum DlnaControlErrorCode {
  /** HTTP status on SOAP control URL was not 2xx */
  SoapHttp = 'dlna.control.soap.http',
  /** SOAP body contained a Fault */
  SoapFault = 'dlna.control.soap.fault',
  /** Request aborted (timeout) */
  SoapTimeout = 'dlna.control.soap.timeout',
  /** Network / fetch failure other than timeout */
  SoapNetwork = 'dlna.control.soap.network',
  /** GetMute/SetMute returned HTTP 500/501 — optional on many renderers */
  SoapMuteUnsupported = 'dlna.control.soap.mute_unsupported',
}
