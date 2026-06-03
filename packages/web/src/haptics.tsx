const HAPTIC_PATTERN_LIGHT = 12;
const HAPTIC_BRIDGE_INPUT_ID = "finn-haptic-bridge-input";
const HAPTIC_BRIDGE_LABEL_ID = "finn-haptic-bridge-label";
const nativeSwitchAttribute = { switch: "" };
const hiddenHapticBridgeStyle = {
  position: "fixed",
  left: "-100vw",
  bottom: "-100vh",
  width: "1px",
  height: "1px",
  opacity: "0",
  pointerEvents: "none",
} satisfies Partial<CSSStyleDeclaration>;

function isAppleMobileWebKit() {
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;

  // iPadOS can present as Macintosh while still exposing touch events.
  return /Macintosh/i.test(userAgent) && "ontouchend" in document;
}

export function ensureHapticBridge() {
  if (typeof document === "undefined" || !document.body) return;
  const host = document.querySelector<HTMLElement>(".sheet") ?? document.getElementById("root") ?? document.body;
  let input = document.getElementById(HAPTIC_BRIDGE_INPUT_ID) as HTMLInputElement | null;
  let label = document.getElementById(HAPTIC_BRIDGE_LABEL_ID) as HTMLLabelElement | null;

  if (!input) {
    input = document.createElement("input");
    input.type = "checkbox";
    input.id = HAPTIC_BRIDGE_INPUT_ID;
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.setAttribute("role", "switch");
    input.setAttribute("switch", "");
    Object.assign(input.style, hiddenHapticBridgeStyle);
  }

  if (!label) {
    label = document.createElement("label");
    label.id = HAPTIC_BRIDGE_LABEL_ID;
    label.htmlFor = HAPTIC_BRIDGE_INPUT_ID;
    label.tabIndex = -1;
    label.setAttribute("aria-hidden", "true");
    Object.assign(label.style, hiddenHapticBridgeStyle);
  }

  if (input.parentElement !== host || label.parentElement !== host) {
    host.append(input, label);
  }
}

export function removeHapticBridge() {
  document.getElementById(HAPTIC_BRIDGE_LABEL_ID)?.remove();
  document.getElementById(HAPTIC_BRIDGE_INPUT_ID)?.remove();
}

export function triggerHapticFeedback() {
  ensureHapticBridge();
  const label = document.getElementById(HAPTIC_BRIDGE_LABEL_ID);
  if (isAppleMobileWebKit()) {
    if (label instanceof HTMLLabelElement) {
      label.click();
    }
    return;
  }

  if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function" && navigator.vibrate(HAPTIC_PATTERN_LIGHT)) {
    return;
  }

  if (label instanceof HTMLLabelElement) {
    label.click();
  }
}

export function HapticSwitchOverlay(props: { disabled?: boolean }) {
  return (
    <input
      {...nativeSwitchAttribute}
      className="haptic-switch-overlay"
      type="checkbox"
      tabIndex={-1}
      aria-hidden="true"
      disabled={props.disabled}
      onClick={(event) => {
        event.currentTarget.checked = false;
      }}
    />
  );
}
