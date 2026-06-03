import type { CommandActivityEvent } from "./types";

export const activityGraceMs = 8_000;

export interface ActivityViewState {
  visible: boolean;
  active: boolean;
  message: string;
  hideAfter: number | null;
  lastChangedAt: number;
  generation: number;
}

export function applyActivityEvent(
  current: ActivityViewState,
  event: CommandActivityEvent,
  now = Date.now(),
): ActivityViewState {
  if (event.generation !== undefined && event.generation <= current.generation) {
    return current;
  }

  const generation = event.generation ?? current.generation;

  if (event.active) {
    return {
      visible: true,
      active: true,
      message: event.message,
      hideAfter: null,
      lastChangedAt: current.message === event.message && current.visible ? current.lastChangedAt : now,
      generation,
    };
  }

  if (!current.visible && !event.message) {
    return {
      ...current,
      generation,
    };
  }

  if (!current.visible) {
    return {
      visible: true,
      active: false,
      message: event.message,
      hideAfter: now + activityGraceMs,
      lastChangedAt: now,
      generation,
    };
  }

  return {
    ...current,
    active: false,
    message: event.message || current.message,
    hideAfter: now + activityGraceMs,
    lastChangedAt: now,
    generation,
  };
}

export function shouldHideActivity(current: ActivityViewState, now = Date.now()): boolean {
  return current.visible && !current.active && current.hideAfter !== null && now >= current.hideAfter;
}

export function hideActivity(current: ActivityViewState, now = Date.now()): ActivityViewState {
  return {
    visible: false,
    active: false,
    message: "",
    hideAfter: null,
    lastChangedAt: now,
    generation: current.generation,
  };
}
