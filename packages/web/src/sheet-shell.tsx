import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Scroll as SilkScroll, Sheet as SilkSheet } from "@silk-hq/components";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Toaster } from "react-hot-toast";

import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";

const stackedBottomSheetAnimation = {
  translateY: ({ progress }: { progress: number }) => (progress <= 1 ? `${progress * -10}px` : `calc(-12.5px + 2.5px * ${progress})`),
  scale: ({ progress }: { progress: number }) => String(1 - Math.min(progress, 1) * 0.067),
  transformOrigin: "50% 0",
};

export type SheetFrameProps = {
  title: string;
  children: ReactNode;
  onBack?: () => void;
  backLabel?: string;
  locked?: boolean;
  className?: string;
};

export type StandaloneSheetFrameProps = {
  title: string;
  className?: string;
  children: ReactNode;
  onClose: () => void;
};

export function AppToaster() {
  return <ToastViewport />;
}

export function ConfirmSheet(props: {
  title: string;
  message: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <StandaloneSheet title={props.title} className="standalone-sheet-fit confirm-sheet-panel" onClose={props.onCancel}>
      <div className="confirm-sheet">
        <SilkSheet.Description className="confirm-sheet-description">
          {props.message}
        </SilkSheet.Description>
        {props.children}
        <div className="confirm-sheet-actions">
          <Button className="confirm-sheet-button" type="button" onClick={props.onCancel}>Cancel</Button>
          <Button className="confirm-sheet-button confirm-sheet-button-danger" type="button" disabled={props.confirmDisabled} onClick={props.onConfirm}>{props.confirmLabel}</Button>
        </div>
      </div>
    </StandaloneSheet>
  );
}

export function StandaloneSheet(props: StandaloneSheetFrameProps) {
  return (
    <SilkSheet.Root
      className="silk-root"
      license="non-commercial"
      presented
      onPresentedChange={(presented) => {
        if (!presented) props.onClose();
      }}
      sheetRole="dialog"
    >
      <SilkSheet.Portal>
        <SilkSheet.View
          className="standalone-sheet-view"
          contentPlacement="bottom"
          tracks="bottom"
          swipeDismissal
          swipeOvershoot={false}
          enteringAnimationSettings="smooth"
          exitingAnimationSettings="smooth"
          onDismissAutoFocus={{ focus: false }}
        >
          <SilkSheet.Backdrop
            className="standalone-sheet-scrim"
            travelAnimation={{ opacity: [0, 0.12] }}
          />
          <SilkSheet.Content className={cn("standalone-sheet", props.className)}>
            <SilkSheet.BleedingBackground className="standalone-sheet-bleeding-background" />
            <SilkSheet.Handle className="grabber" action="dismiss">Dismiss {props.title}</SilkSheet.Handle>
            <header className="standalone-sheet-header">
              <SilkSheet.Title asChild>
                <h3>{props.title}</h3>
              </SilkSheet.Title>
            </header>
            <SilkScroll.Root className="standalone-sheet-scroll-root">
              <SilkScroll.View
                className="standalone-sheet-body"
                safeArea="visual-viewport"
                scrollGestureTrap={{ yEnd: true }}
                nativeScrollbar={false}
                onFocusInside={{ scrollIntoView: true }}
                onScrollStart={{ dismissKeyboard: false }}
              >
                <SilkScroll.Content className="standalone-sheet-scroll-content">
                  {props.children}
                </SilkScroll.Content>
              </SilkScroll.View>
            </SilkScroll.Root>
          </SilkSheet.Content>
        </SilkSheet.View>
      </SilkSheet.Portal>
    </SilkSheet.Root>
  );
}

export function SheetFrame(props: SheetFrameProps & { onTravelProgress: (progress: number) => void }) {
  const [toastPortal, setToastPortal] = useState<HTMLDivElement | null>(null);

  return (
    <SilkSheet.Portal>
      <SilkSheet.View
        className="silk-sheet-view"
        contentPlacement="bottom"
        tracks="bottom"
        swipeDismissal
        swipeOvershoot={false}
        enteringAnimationSettings="smooth"
        exitingAnimationSettings="smooth"
        onTravel={({ progress }) => props.onTravelProgress(progress)}
        onDismissAutoFocus={{ focus: false }}
      >
        <SilkSheet.Backdrop
          className="sheet-scrim"
          travelAnimation={{ opacity: [0, 0.18] }}
        />
        <div ref={setToastPortal} className="sheet-toast-layer" />
        <SheetToaster portal={toastPortal} />
        <SilkSheet.Content className={cn("sheet", props.className, props.locked && "sheet-locked")} stackingAnimation={stackedBottomSheetAnimation}>
          <SilkSheet.BleedingBackground className="sheet-bleeding-background" />
          {props.locked ? (
            <span className="grabber grabber-locked" aria-hidden="true" />
          ) : (
            <SilkSheet.Handle className="grabber" action="dismiss">Dismiss {props.title}</SilkSheet.Handle>
          )}
          <header className="sheet-header">
            {props.onBack ? (
              <button className="sheet-back" type="button" aria-label={props.backLabel ?? `Back from ${props.title}`} onClick={props.onBack}>
                <HugeiconsIcon icon={ArrowLeft01Icon} size={20} strokeWidth={2.1} />
              </button>
            ) : null}
            <SilkSheet.Title asChild>
              <h2>{props.title}</h2>
            </SilkSheet.Title>
          </header>
          <SilkScroll.Root className="sheet-scroll-root">
            <SilkScroll.View
              className="sheet-body"
              safeArea="visual-viewport"
              scrollGestureTrap={{ yEnd: true }}
              nativeScrollbar={false}
              onFocusInside={{ scrollIntoView: true }}
              onScrollStart={{ dismissKeyboard: false }}
            >
              <SilkScroll.Content className="sheet-scroll-content">
                {props.children}
              </SilkScroll.Content>
            </SilkScroll.View>
          </SilkScroll.Root>
        </SilkSheet.Content>
      </SilkSheet.View>
    </SilkSheet.Portal>
  );
}

function SheetToaster(props: { portal: HTMLDivElement | null }) {
  return props.portal ? createPortal(<ToastViewport />, props.portal) : null;
}

function ToastViewport() {
  return (
    <Toaster
      position="top-center"
      toastOptions={{
        className: "app-toast",
        duration: 2600,
        success: { iconTheme: { primary: "#2d2d37", secondary: "#f6f6f6" } },
        error: { iconTheme: { primary: "#9a2636", secondary: "#f6f6f6" } },
      }}
      containerClassName="app-toast-viewport"
      containerStyle={{ top: `calc(var(--safe-area-inset-top) + 14px)` }}
    />
  );
}
