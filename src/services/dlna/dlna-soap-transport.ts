import { DlnaControlError } from './dlna-control-error';
import { DlnaControlErrorCode } from './dlna-control-error-codes';
import { escapeXml, truncateLogSnippet } from './dlna-xml';

export type DlnaSoapLogLevel = 'info' | 'warn' | 'error';

export type DlnaSoapLogFn = (level: DlnaSoapLogLevel, event: string, details?: Record<string, unknown>) => void;

export type ExecuteDlnaSoapRequestParams = {
  controlUrl: string;
  serviceType: string;
  actionName: string;
  params: Record<string, string>;
  timeoutMs: number;
  optionalRenderingControlMute?: boolean;
  log: DlnaSoapLogFn;
  snippetMaxLength?: number;
};

function isMuteHttpUnsupportedStatus(httpStatus: number): boolean {
  return httpStatus === 500 || httpStatus === 501;
}

/**
 * Single entry point for renderer UPnP SOAP control requests — throws {@link DlnaControlError} with stable codes.
 */
export async function executeDlnaSoapRequest(p: ExecuteDlnaSoapRequestParams): Promise<string> {
  const {
    controlUrl,
    serviceType,
    actionName,
    params,
    timeoutMs,
    optionalRenderingControlMute,
    log,
  } = p;
  const maxLen = p.snippetMaxLength ?? 1800;
  const startedAt = Date.now();
  const actionBody = Object.entries(params)
    .map(([key, value]) => `<${key}>${escapeXml(String(value || ''))}</${key}>`)
    .join('');
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:${actionName} xmlns:u="${serviceType}">
${actionBody}
</u:${actionName}>
</s:Body>
</s:Envelope>`;
  log('info', 'soap_request', {
    actionName,
    serviceType,
    controlUrl,
    timeoutMs,
    params,
    requestBody: truncateLogSnippet(body, maxLen),
  });

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);
  try {
    const response = await fetch(controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPACTION: `"${serviceType}#${actionName}"`,
      },
      body,
      signal: abortController.signal,
    });
    const responseBody = await response.text().catch(() => '');
    log('info', 'soap_response', {
      actionName,
      serviceType,
      controlUrl,
      elapsedMs: Date.now() - startedAt,
      status: response.status,
      ok: response.ok,
      responseBody: truncateLogSnippet(responseBody, maxLen),
    });
    if (!response.ok) {
      if (optionalRenderingControlMute && isMuteHttpUnsupportedStatus(response.status)) {
        log('warn', 'renderer_mute_control_unsupported', {
          actionName,
          serviceType,
          controlUrl,
          elapsedMs: Date.now() - startedAt,
          httpStatus: response.status,
          error: `DLNA SOAP ${actionName} failed: HTTP ${response.status}`,
        });
        throw new DlnaControlError({
          code: DlnaControlErrorCode.SoapMuteUnsupported,
          message: `DLNA SOAP ${actionName} failed: HTTP ${response.status}`,
          soapAction: actionName,
          controlUrl,
          serviceType,
          httpStatus: response.status,
          phase: 'response',
        });
      }
      const err = new DlnaControlError({
        code: DlnaControlErrorCode.SoapHttp,
        message: `DLNA SOAP ${actionName} failed: HTTP ${response.status}`,
        soapAction: actionName,
        controlUrl,
        serviceType,
        httpStatus: response.status,
        phase: 'response',
      });
      log('error', 'soap_request_failed', {
        ...err.toLogDetails(),
        elapsedMs: Date.now() - startedAt,
      });
      throw err;
    }
    if (/<(?:\w+:)?Fault>/i.test(responseBody)) {
      log('warn', 'soap_fault_response', {
        actionName,
        serviceType,
        controlUrl,
        elapsedMs: Date.now() - startedAt,
        responseBody: truncateLogSnippet(responseBody, maxLen),
      });
      const err = new DlnaControlError({
        code: DlnaControlErrorCode.SoapFault,
        message: `DLNA SOAP ${actionName} fault response`,
        soapAction: actionName,
        controlUrl,
        serviceType,
        phase: 'parse',
      });
      log('error', 'soap_request_failed', {
        ...err.toLogDetails(),
        elapsedMs: Date.now() - startedAt,
      });
      throw err;
    }
    return responseBody;
  } catch (error: unknown) {
    if (error instanceof DlnaControlError) {
      throw error;
    }
    if (error && typeof error === 'object' && (error as { name?: string }).name === 'AbortError') {
      const err = new DlnaControlError({
        code: DlnaControlErrorCode.SoapTimeout,
        message: `DLNA SOAP ${actionName} timeout`,
        soapAction: actionName,
        controlUrl,
        serviceType,
        phase: 'request',
      });
      log('error', 'soap_request_timeout', {
        ...err.toLogDetails(),
        elapsedMs: Date.now() - startedAt,
      });
      throw err;
    }
    const err = new DlnaControlError({
      code: DlnaControlErrorCode.SoapNetwork,
      message: String((error as Error)?.message || error || 'DLNA SOAP network error'),
      soapAction: actionName,
      controlUrl,
      serviceType,
      phase: 'request',
      cause: error,
    });
    log('error', 'soap_request_failed', {
      ...err.toLogDetails(),
      elapsedMs: Date.now() - startedAt,
    });
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
