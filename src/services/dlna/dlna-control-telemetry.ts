import crypto from 'crypto';

type ControlStackFrame = {
  opId: string;
  opType: string;
  rendererId?: string;
};

function createOperationId(): string {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * Lightweight operation context for DLNA **control** (serialized renderer commands, snapshot polls).
 * Every `dlna.log` line can include `dlnaOpId` + `dlnaOpType` to tie SOAP failures to a user action.
 */
const stack: ControlStackFrame[] = [];

export const DlnaControlTelemetry = {
  beginOperation(opType: string, rendererId?: string): void {
    stack.push({
      opId: createOperationId(),
      opType,
      rendererId,
    });
  },

  endOperation(): void {
    stack.pop();
  },

  /** Fields merged into the root of each `dlna.log` JSON line (when stack non-empty). */
  getActiveFields(): Record<string, string | undefined> {
    const top = stack[stack.length - 1];
    if (!top) {
      return {};
    }
    return {
      dlnaLayer: 'dlna.control',
      dlnaOpId: top.opId,
      dlnaOpType: top.opType,
      dlnaOpRendererId: top.rendererId,
    };
  },

  depth(): number {
    return stack.length;
  },
};
