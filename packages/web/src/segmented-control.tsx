import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "./lib/utils";

export type SegmentedOption<T extends string> = { value: T; label: string; icon?: ReactNode };

export function SegmentedControl<T extends string>(props: {
  value: T;
  options: readonly SegmentedOption<T>[];
  ariaLabel: string;
  className?: string;
  onValueChange?: (value: T) => void;
  onHaptic?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef(new Map<T, HTMLButtonElement>());
  const [indicator, setIndicator] = useState({ x: 0, width: 0, ready: false });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const activeButton = buttonRefs.current.get(props.value);
    if (!root || !activeButton) {
      setIndicator((current) => current.ready ? { ...current, ready: false } : current);
      return;
    }

    const updateIndicator = () => {
      const rootRect = root.getBoundingClientRect();
      const buttonRect = activeButton.getBoundingClientRect();
      setIndicator({
        x: buttonRect.left - rootRect.left,
        width: buttonRect.width,
        ready: true,
      });
    };

    updateIndicator();

    const resizeObserver = new ResizeObserver(updateIndicator);
    resizeObserver.observe(root);
    resizeObserver.observe(activeButton);
    return () => {
      resizeObserver.disconnect();
    };
  }, [props.value]);

  return (
    <div
      ref={rootRef}
      className={cn("segmented-control", props.className)}
      data-option-count={props.options.length}
      role="group"
      aria-label={props.ariaLabel}
    >
      <div
        aria-hidden="true"
        className="segmented-control-indicator"
        style={{
          width: indicator.width,
          transform: `translate3d(${indicator.x}px, 0, 0)`,
          opacity: indicator.ready ? 1 : 0,
        }}
      />
      {props.options.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) {
                buttonRefs.current.set(option.value, node);
              } else {
                buttonRefs.current.delete(option.value);
              }
            }}
            className="segmented-control-button"
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) {
                props.onHaptic?.();
                props.onValueChange?.(option.value);
              }
            }}
          >
            <span className="segmented-control-label">
              {option.icon}
              <span>{option.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
