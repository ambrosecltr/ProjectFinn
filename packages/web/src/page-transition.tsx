import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "./lib/utils";

export type PageSlideDirection = "forward" | "back";

interface PreviousPage {
  key: string;
  children: ReactNode;
  direction: PageSlideDirection;
}

const PAGE_SLIDE_DURATION_MS = 200;

function orderedPageDirection<T extends string>(previous: T, next: T, order: readonly T[]): PageSlideDirection {
  const previousIndex = order.indexOf(previous);
  const nextIndex = order.indexOf(next);
  return previousIndex >= 0 && nextIndex >= 0 && nextIndex < previousIndex ? "back" : "forward";
}

export function useOrderedPageDirection<T extends string>(value: T, order: readonly T[]): PageSlideDirection {
  const previousValueRef = useRef(value);
  const direction = orderedPageDirection(previousValueRef.current, value, order);

  useEffect(() => {
    previousValueRef.current = value;
  }, [value]);

  return direction;
}

export function useDepthPageDirection(depth: number): PageSlideDirection {
  const previousDepthRef = useRef(depth);
  const direction = depth < previousDepthRef.current ? "back" : "forward";

  useEffect(() => {
    previousDepthRef.current = depth;
  }, [depth]);

  return direction;
}

export function PageTransition(props: {
  pageKey: string;
  direction?: PageSlideDirection;
  className?: string;
  children: ReactNode;
}) {
  const [previousPage, setPreviousPage] = useState<PreviousPage | null>(null);
  const previousKeyRef = useRef(props.pageKey);
  const previousChildrenRef = useRef(props.children);
  const timeoutRef = useRef<number | null>(null);
  const [animationEnabled, setAnimationEnabled] = useState(() => typeof window === "undefined" || !window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateAnimationEnabled = () => setAnimationEnabled(!motionQuery.matches);
    updateAnimationEnabled();
    motionQuery.addEventListener("change", updateAnimationEnabled);
    return () => motionQuery.removeEventListener("change", updateAnimationEnabled);
  }, []);

  useLayoutEffect(() => {
    if (previousKeyRef.current === props.pageKey) {
      previousChildrenRef.current = props.children;
      return;
    }

    if (!animationEnabled) {
      previousKeyRef.current = props.pageKey;
      previousChildrenRef.current = props.children;
      setPreviousPage(null);
      return;
    }

    const outgoingPage: PreviousPage = {
      key: previousKeyRef.current,
      children: previousChildrenRef.current,
      direction: props.direction ?? "forward",
    };

    setPreviousPage(outgoingPage);
    previousKeyRef.current = props.pageKey;
    previousChildrenRef.current = props.children;

    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = window.setTimeout(() => {
      setPreviousPage((current) => current?.key === outgoingPage.key ? null : current);
      timeoutRef.current = null;
    }, PAGE_SLIDE_DURATION_MS);
  }, [animationEnabled, props.pageKey, props.children, props.direction]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <div className={cn("page-slide", props.className)} data-direction={previousPage?.direction ?? props.direction ?? "forward"} data-has-previous={previousPage ? "true" : undefined}>
      {previousPage ? (
        <div className="page-slide-page page-slide-page-exit" key={`previous-${previousPage.key}`} aria-hidden="true" inert>
          {previousPage.children}
        </div>
      ) : null}
      <div className="page-slide-page page-slide-page-active" key={`active-${props.pageKey}`}>
        {props.children}
      </div>
    </div>
  );
}
