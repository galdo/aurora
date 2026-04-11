import { DlnaControlErrorCode } from './dlna-control-error-codes';

export type DlnaControlErrorInit = {
  code: DlnaControlErrorCode;
  message: string;
  soapAction?: string;
  controlUrl?: string;
  serviceType?: string;
  httpStatus?: number;
  phase: 'request' | 'response' | 'parse';
  cause?: unknown;
};

/**
 * Typed error for renderer UPnP SOAP control. Lets logs and UI correlate failures.
 */
export class DlnaControlError extends Error {
  readonly code: DlnaControlErrorCode;
  readonly soapAction?: string;
  readonly controlUrl?: string;
  readonly serviceType?: string;
  readonly httpStatus?: number;
  readonly phase: 'request' | 'response' | 'parse';

  constructor(init: DlnaControlErrorInit) {
    super(init.message);
    this.name = 'DlnaControlError';
    this.code = init.code;
    this.soapAction = init.soapAction;
    this.controlUrl = init.controlUrl;
    this.serviceType = init.serviceType;
    this.httpStatus = init.httpStatus;
    this.phase = init.phase;
    if (init.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = init.cause;
    }
    Object.setPrototypeOf(this, DlnaControlError.prototype);
  }

  toLogDetails(): Record<string, unknown> {
    return {
      dlnaErrorCode: this.code,
      dlnaErrorPhase: this.phase,
      soapAction: this.soapAction,
      httpStatus: this.httpStatus,
      controlUrl: this.controlUrl,
      serviceType: this.serviceType,
      message: this.message,
    };
  }

  static isDlnaControlError(value: unknown): value is DlnaControlError {
    return value instanceof DlnaControlError;
  }
}
