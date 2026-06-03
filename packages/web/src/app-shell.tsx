import { FinnMark } from "./dashboard";

export function preventImageInteractions(event: Event) {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("img")) {
    return;
  }

  event.preventDefault();
}

export function AuthTopBar() {
  return (
    <header className="topbar auth-topbar">
      <FinnMark />
    </header>
  );
}

export function AppBackground() {
  return (
    <div className="app-background" aria-hidden="true">
      <div className="surface-grain" />
    </div>
  );
}

export function installDisplayModeAttribute() {
  const standaloneQuery = window.matchMedia("(display-mode: standalone)");
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  const update = () => {
    document.documentElement.dataset.displayMode =
      standaloneQuery.matches || iosNavigator.standalone === true ? "standalone" : "browser";
  };

  update();
  standaloneQuery.addEventListener("change", update);
}
