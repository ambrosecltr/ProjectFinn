import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import loaderUrl from "./assets/matrix-loader.svg";
import {
  applyActivityEvent,
  hideActivity,
  shouldHideActivity,
  type ActivityViewState,
} from "./activity";
import type { CommandActivityEvent } from "./types";

const initialActivity: ActivityViewState = {
  visible: false,
  active: false,
  message: "",
  hideAfter: null,
  lastChangedAt: 0,
  generation: 0,
};

const activityWindowInset = 48;

export function NotificationApp() {
  const [activity, setActivity] = useState<ActivityViewState>(initialActivity);
  const activityRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    const applyNativeActivityEvent = (event: CommandActivityEvent) => {
      setActivity((current) => applyActivityEvent(current, event));
    };
    const applyCustomActivityEvent = (event: Event) => {
      applyNativeActivityEvent((event as CustomEvent<CommandActivityEvent>).detail);
    };

    window.addEventListener("puter_command_activity", applyCustomActivityEvent);

    void listen<CommandActivityEvent>("puter_command_activity", (event) => {
      applyNativeActivityEvent(event.payload);
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      cleanup = unlisten;
    });

    return () => {
      disposed = true;
      window.removeEventListener("puter_command_activity", applyCustomActivityEvent);
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    const element = activityRef.current;
    if (!element) {
      return;
    }

    let frame = 0;
    const resize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = element.getBoundingClientRect();
        void invoke("resize_activity_window", {
          width: Math.ceil(rect.width + activityWindowInset),
          height: Math.ceil(rect.height + activityWindowInset),
        }).catch((error: unknown) => {
          console.warn("Could not resize Finn activity window.", error);
        });
      });
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(element);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [activity.message, activity.visible]);

  useEffect(() => {
    if (!activity.visible || activity.hideAfter === null) {
      return;
    }

    const delay = Math.max(0, activity.hideAfter - Date.now());
    const timer = window.setTimeout(() => {
      setActivity((current) => (shouldHideActivity(current) ? hideActivity(current) : current));
    }, delay);

    return () => window.clearTimeout(timer);
  }, [activity.visible, activity.hideAfter]);

  return (
    <main className="activity-shell">
      <section ref={activityRef} className="activity-window" data-visible={activity.visible} data-active={activity.active} role="status" aria-live="polite">
        <img className="activity-loader" src={loaderUrl} alt="" draggable={false} />
        <p key={activity.message}>{activity.message || "Finn is accessing your Mac..."}</p>
      </section>
    </main>
  );
}
