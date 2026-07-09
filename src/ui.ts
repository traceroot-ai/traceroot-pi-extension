// TUI status indicator and trace widget. Every call is guarded: a mode that
// lacks the method, or any throw, is swallowed so UI is never a failure surface.
import type { TracerootPiConfig } from './config.ts';
import type { ExtensionContext } from './types.ts';

const STATUS_KEY = 'traceroot';
const WIDGET_KEY = 'traceroot';

export const STATUS_ACTIVE = 'Traceroot ●';
export const STATUS_INACTIVE = 'Traceroot ○';

// README documents TRACEROOT_SHOW_UI as controlling the status indicator AND the
// trace widget; both must honor it or opting out leaves a permanent "Traceroot ●"
// in the status bar.
export function setStatus(
  ctx: ExtensionContext | undefined,
  config: TracerootPiConfig,
  text: string | undefined,
): void {
  try {
    if (ctx?.hasUI && config.showUiIndicator) ctx.ui.setStatus(STATUS_KEY, text);
  } catch {
    /* ui unavailable in this mode */
  }
}

export function updateTraceLinkWidget(
  ctx: ExtensionContext | undefined,
  details: { enabled: boolean; traceId: string | null },
): void {
  try {
    if (!ctx?.hasUI || !details.enabled || !details.traceId) return;
    ctx.ui.setWidget(WIDGET_KEY, [`Traceroot trace: ${details.traceId}`], {
      placement: 'belowEditor',
    });
  } catch {
    /* ui unavailable in this mode */
  }
}

export function clearWidget(ctx: ExtensionContext | undefined): void {
  try {
    if (ctx?.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  } catch {
    /* ui unavailable in this mode */
  }
}

const ISSUE_KEY = 'traceroot-config';

// Surface a configuration problem in the TUI so a silent misconfig is visible.
export function setConfigIssue(
  ctx: ExtensionContext | undefined,
  issue: { message: string; severity: 'error' | 'warning' } | undefined,
): void {
  try {
    if (!ctx?.hasUI) return;
    if (!issue) {
      ctx.ui.setWidget(ISSUE_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(ISSUE_KEY, [`Traceroot config ${issue.severity}: ${issue.message}`], {
      placement: 'belowEditor',
    });
  } catch {
    /* ui unavailable in this mode */
  }
}
