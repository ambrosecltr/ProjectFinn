import { updateThemeColor } from "@silk-hq/components";

import afternoonSceneUrl from "./assets/scene_afternoon.avif";
import morningSceneUrl from "./assets/scene_morning.avif";
import nightSceneUrl from "./assets/scene_night.avif";
import profileHeaderUrl from "./assets/profile_header.avif";
import type { AppTheme, AppThemeName, UserProfile } from "./web-types";

export { profileHeaderUrl };

interface WeatherSummary {
  text: string;
}

export function preloadImageSource(src?: string | null) {
  if (src && typeof Image !== "undefined") {
    const image = new Image();
    image.decoding = "async";
    image.src = src;
  }
}

const openBackdropColor = [0, 0, 0] as const;
const fallbackAppClosedColor = [255, 255, 255] as const;
const WINDOW_TOP_OFFSET = 26;
const appThemes = {
  morning: {
    name: "morning",
    backgroundUrl: morningSceneUrl,
    imageScale: 1,
    chromeColor: "#E8E5E2",
    chromeRgb: [232, 229, 226],
    foregroundColor: "#4B525D",
    foregroundMutedColor: "#4B525DB3",
    menuTextColor: "#4B525DC2",
    menuSurfaceColor: "#E8E5E2",
    menuBorderColor: "#E1DAD4",
    topbarDateColor: "#4B525D94",
    logoFilter: "invert(31%)",
    sceneFilter: "saturate(200%)",
  },
  afternoon: {
    name: "afternoon",
    backgroundUrl: afternoonSceneUrl,
    imageScale: 1,
    chromeColor: "#E8E1DA",
    chromeRgb: [232, 225, 218],
    foregroundColor: "#4B525D",
    foregroundMutedColor: "#4B525DB3",
    menuTextColor: "#4B525DC2",
    menuSurfaceColor: "#E8E1DA",
    menuBorderColor: "#DED7D0",
    topbarDateColor: "#4B525D94",
    logoFilter: "invert(31%)",
    sceneFilter: "saturate(143%)",
  },
  night: {
    name: "night",
    backgroundUrl: nightSceneUrl,
    imageScale: 1,
    chromeColor: "#0B1016",
    chromeRgb: [11, 16, 22],
    foregroundColor: "#FFFFFF",
    foregroundMutedColor: "#FFFFFFB3",
    menuTextColor: "#FFFFFFD4",
    menuSurfaceColor: "#181F27",
    menuBorderColor: "#282E36",
    topbarDateColor: "#FFFFFFCF",
    logoFilter: "invert(100%)",
    sceneFilter: "saturate(200%)",
  },
} satisfies Record<AppThemeName, AppTheme>;

function clampProgress(progress: number): number {
  return Math.min(Math.max(progress, 0), 1);
}

function getSafeAreaTop(): number {
  const value = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-area-inset-top"));
  return Number.isFinite(value) ? value : 0;
}

function blendColor(from: readonly [number, number, number], to: readonly [number, number, number], progress: number): string {
  const value = from.map((channel, index) => Math.round(channel + (to[index] - channel) * progress));
  return `rgb(${value[0]}, ${value[1]}, ${value[2]})`;
}

function setAppThemeColor(color: string) {
  updateThemeColor(color);
  document.querySelectorAll<HTMLMetaElement>("meta[name='theme-color']").forEach((element) => {
    element.setAttribute("content", color);
  });
}

function getDeviceThemeName(date: Date): AppThemeName {
  const hour = date.getHours();
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  return "night";
}

export function getThemeForDate(date: Date): AppTheme {
  return appThemes[getDeviceThemeName(date)];
}

function formatWeatherCode(code: number): string {
  if (code === 0) return "clear";
  if ([1, 2].includes(code)) return "partly cloudy";
  if (code === 3) return "cloudy";
  if ([45, 48].includes(code)) return "foggy";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rainy";
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return "snowy";
  if (code >= 95) return "stormy";
  return "current weather";
}

const weatherFallbackQuotes = [
  "Take the day gently",
  "One thing at a time",
  "There is still room to breathe",
  "Move softly through the next hour",
  "Let the day meet you slowly",
  "A little quiet counts too",
] as const;

function getWeatherFallbackQuote(): string {
  return weatherFallbackQuotes[Math.floor(Math.random() * weatherFallbackQuotes.length)] ?? weatherFallbackQuotes[0];
}

async function getProfileCoordinates(location: string): Promise<{ latitude: number; longitude: number } | null> {
  const trimmed = location.trim();
  if (!trimmed) {
    return null;
  }

  const coordinateMatch = trimmed.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coordinateMatch) {
    return {
      latitude: Number(coordinateMatch[1]),
      longitude: Number(coordinateMatch[2]),
    };
  }

  const params = new URLSearchParams({
    name: trimmed,
    count: "1",
    language: "en",
    format: "json",
  });
  const response = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
  if (!response.ok) {
    return null;
  }

  const body = await response.json() as { results?: Array<{ latitude: number; longitude: number }> };
  const result = body.results?.[0];
  return result ? { latitude: result.latitude, longitude: result.longitude } : null;
}

function getBrowserCoordinates(): Promise<{ latitude: number; longitude: number } | null> {
  if (!navigator.geolocation) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      }),
      () => resolve(null),
      { enableHighAccuracy: false, maximumAge: 30 * 60 * 1000, timeout: 2500 },
    );
  });
}

function formatLocationParts(primary?: string | null, country?: string | null): string | null {
  const parts = [primary, country]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? [...new Set(parts)].join(", ") : null;
}

async function getLocationLabelFromCoordinates(coordinates: { latitude: number; longitude: number }): Promise<string | null> {
  const params = new URLSearchParams({
    latitude: String(coordinates.latitude),
    longitude: String(coordinates.longitude),
    localityLanguage: "en",
  });
  const response = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?${params}`);
  if (!response.ok) {
    return null;
  }

  const body = await response.json() as {
    locality?: string;
    city?: string;
    principalSubdivision?: string;
    countryName?: string;
  };
  return formatLocationParts(body.locality || body.city || body.principalSubdivision, body.countryName);
}

async function getIpLocationLabel(): Promise<string | null> {
  const response = await fetch("https://ipapi.co/json/");
  if (!response.ok) {
    return null;
  }

  const body = await response.json() as { city?: string; region?: string; country_name?: string };
  return formatLocationParts(body.city || body.region, body.country_name);
}

export async function suggestHomeLocation(): Promise<string | null> {
  const browserCoordinates = await getBrowserCoordinates();
  if (browserCoordinates) {
    const label = await getLocationLabelFromCoordinates(browserCoordinates);
    if (label) {
      return label;
    }
  }

  return getIpLocationLabel();
}

async function getIpCoordinates(): Promise<{ latitude: number; longitude: number } | null> {
  const response = await fetch("https://ipapi.co/json/");
  if (!response.ok) {
    return null;
  }

  const body = await response.json() as { latitude?: number; longitude?: number };
  return typeof body.latitude === "number" && typeof body.longitude === "number"
    ? { latitude: body.latitude, longitude: body.longitude }
    : null;
}

export async function getWeatherSummary(user: UserProfile): Promise<WeatherSummary> {
  const profileCoordinates = await getProfileCoordinates(user.location);
  const coordinates = profileCoordinates ?? await getBrowserCoordinates() ?? await getIpCoordinates();

  if (!coordinates) {
    return { text: getWeatherFallbackQuote() };
  }

  const params = new URLSearchParams({
    latitude: String(coordinates.latitude),
    longitude: String(coordinates.longitude),
    current: "temperature_2m,weather_code",
    timezone: "auto",
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) {
    return { text: getWeatherFallbackQuote() };
  }

  const body = await response.json() as {
    current?: { temperature_2m?: number; weather_code?: number };
    current_units?: { temperature_2m?: string };
  };
  const temperature = body.current?.temperature_2m;
  const weatherCode = body.current?.weather_code;

  if (typeof temperature !== "number" || typeof weatherCode !== "number") {
    return { text: getWeatherFallbackQuote() };
  }

  const unit = body.current_units?.temperature_2m ?? "°C";
  return {
    text: `${Math.round(temperature)}${unit.replace("°C", "°")} and ${formatWeatherCode(weatherCode)}`,
  };
}

function colorTupleToRgb(color: readonly [number, number, number]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function getAppClosedColor(): readonly [number, number, number] {
  if (typeof document === "undefined") return fallbackAppClosedColor;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--app-closed-rgb").trim();
  const channels = value.split(/\s+/).map((channel) => Number.parseFloat(channel));
  return channels.length === 3 && channels.every(Number.isFinite)
    ? [channels[0], channels[1], channels[2]]
    : fallbackAppClosedColor;
}

export function setAppClosedChrome(theme: AppTheme | null) {
  const color = theme?.chromeColor ?? colorTupleToRgb(fallbackAppClosedColor);
  const rgb = theme?.chromeRgb ?? fallbackAppClosedColor;

  document.documentElement.style.setProperty("--app-closed-rgb", `${rgb[0]} ${rgb[1]} ${rgb[2]}`);
  document.documentElement.style.setProperty("--app-backdrop-color", color);
  document.documentElement.style.setProperty("--app-surface-color", color);
  document.body.style.backgroundColor = color;
  setAppThemeColor(color);
}

export function setSheetBackdropProgress(progress: number) {
  const clampedProgress = clampProgress(progress);
  const appClosedColor = getAppClosedColor();
  const color = clampedProgress === 0
    ? colorTupleToRgb(appClosedColor)
    : blendColor(appClosedColor, openBackdropColor, clampedProgress);
  const wrapper = document.querySelector<HTMLElement>("[data-silk-sheet-wrapper]");

  if (wrapper) {
    if (clampedProgress === 0) {
      wrapper.style.transform = "";
      wrapper.style.transformOrigin = "";
      wrapper.style.borderRadius = "";
      wrapper.style.overflow = "";
      wrapper.style.filter = "";
      wrapper.style.backdropFilter = "";
    } else {
      const safeAreaTop = getSafeAreaTop();
      const openScale = Math.max(window.innerWidth - WINDOW_TOP_OFFSET, 0) / Math.max(window.innerWidth, 1);
      const scale = Math.min(openScale + (1 - clampedProgress) * (1 - openScale), 1);
      const y = Math.max(0, 14 + safeAreaTop - (1 - clampedProgress) * (14 + safeAreaTop));
      const radius = 42 - (1 - clampedProgress) * 42;
      const brightness = 1 - 0.2 * clampedProgress;

      wrapper.style.transform = `translate3d(0, ${y}px, 0) scale(${scale})`;
      wrapper.style.transformOrigin = "50% 0";
      wrapper.style.borderRadius = `${radius}px`;
      wrapper.style.overflow = "hidden";
      wrapper.style.filter = `brightness(${brightness})`;
      wrapper.style.backdropFilter = `brightness(${brightness})`;
    }
  }

  document.documentElement.style.setProperty("--sheet-progress", String(clampedProgress));
  document.documentElement.style.setProperty("--app-backdrop-color", color);
  document.documentElement.style.setProperty("--app-surface-color", colorTupleToRgb(appClosedColor));
  document.body.style.backgroundColor = color;
  setAppThemeColor(color);
}

export function getAuthGreeting(date: Date): string {
  const timeOfDay = getDeviceThemeName(date);
  if (timeOfDay === "morning") return "Good morning.";
  if (timeOfDay === "afternoon") return "Good afternoon.";
  return "Good evening.";
}

export function dashboardClockParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);

  const values = new Map(parts.map((part) => [part.type, part.value]));
  const dayLabel = `${values.get("weekday") ?? ""}, ${values.get("month") ?? ""} ${values.get("day") ?? ""}`.trim();
  const timeOfDay = getDeviceThemeName(date);

  if (timeOfDay === "morning") return { dayLabel, greeting: "Good morning" };
  if (timeOfDay === "afternoon") return { dayLabel, greeting: "Good afternoon" };
  return { dayLabel, greeting: "Good evening" };
}
