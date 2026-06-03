import {
  ArrowLeft01Icon,
  Camera01Icon,
  ChildIcon,
  Logout04Icon,
  Search01Icon,
  Time02Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import profileHeaderUrl from "./assets/profile_header.avif";
import { DashRing } from "./components/loading-ui/dash-ring";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { cn } from "./lib/utils";
import { formatTimeZoneLabel, resolveBrowserTimeZone } from "./lib/timezones";
import { PageTransition, useOrderedPageDirection } from "./page-transition";
import { countries, formatPhoneForCountry, inferCountryCodeFromPhone, normalizePhoneForCountry } from "./phone-utils";
import type { CountryCode, ProfileFieldName, ProfilePatch, SettingsView, UserProfile } from "./web-types";
import { preloadedImageStyle } from "./web-utils";

const settingsViewValues = ["menu", "profile", "settings"] as const satisfies readonly SettingsView[];

function ProfileIdentityHeader(props: {
  displayName: string;
  phoneNumber: string;
  imageUrl?: string | null;
  editable?: boolean;
  uploading?: boolean;
  onImageSelect?: (file: File) => void;
}) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="profile-identity">
      <div className="profile-visual-header">
        <span className="profile-header-image app-image" style={preloadedImageStyle(profileHeaderUrl)} aria-hidden="true" />
        <span className="profile-avatar">
          {props.imageUrl ? (
            <span className="profile-avatar-image app-image" style={preloadedImageStyle(props.imageUrl)} aria-hidden="true" />
          ) : (
            <span className="profile-avatar-initial">{(props.displayName[0] || "A").toUpperCase()}</span>
          )}
          {props.editable ? (
            <>
              <button
                className="profile-avatar-camera"
                type="button"
                aria-label="Change profile image"
                disabled={props.uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                <HugeiconsIcon icon={Camera01Icon} size={21} strokeWidth={2} aria-hidden="true" />
              </button>
              <input
                ref={fileInputRef}
                id={inputId}
                className="profile-image-input"
                type="file"
                accept="image/jpeg,image/png,image/webp,image/avif"
                disabled={props.uploading}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) {
                    props.onImageSelect?.(file);
                  }
                }}
              />
            </>
          ) : null}
          {props.uploading ? (
            <span className="profile-avatar-loading" aria-live="polite" aria-label="Uploading profile image">
              <DashRing className="profile-avatar-loader" aria-hidden="true" />
            </span>
          ) : null}
        </span>
      </div>
      <strong>{props.displayName}</strong>
      <span>{props.phoneNumber}</span>
    </div>
  );
}


export function SettingsSheet(props: {
  user: UserProfile;
  saving: boolean;
  savingField: ProfileFieldName | null;
  profileImageUploading: boolean;
  onSave: (patch: ProfilePatch, field: ProfileFieldName) => void;
  onProfileImageUpload: (file: File) => void;
  onLogout: () => void;
  onOpenTimeZonePicker: (options: { value: string; onSelect: (timezone: string) => void }) => void;
  SheetComponent: (props: { title: string; children: ReactNode; onBack?: () => void; backLabel?: string; locked?: boolean; className?: string }) => ReactNode;
  onHapticFeedback: () => void;
}) {
  const SheetComponent = props.SheetComponent;
  const [view, setView] = useState<SettingsView>("menu");
  const initialPhoneCountry = inferCountryCodeFromPhone(props.user.phoneNumber);
  const [profile, setProfile] = useState({
    ...props.user,
    phoneNumber: formatPhoneForCountry(props.user.phoneNumber, initialPhoneCountry),
  });
  const [profilePhoneCountry, setProfilePhoneCountry] = useState<CountryCode>(initialPhoneCountry);
  const savedDisplayName = props.user.displayName.trim() || "Profile";
  const savedPhoneNumber = formatPhoneForCountry(props.user.phoneNumber, inferCountryCodeFromPhone(props.user.phoneNumber));
  const timezoneUsesServerDefault = profile.timezoneSource === "server";
  const activeTimezone = resolveBrowserTimeZone(profile.timezone);
  const normalizedProfilePhoneNumber = normalizePhoneForCountry(profile.phoneNumber, profilePhoneCountry);
  const normalizedSavedPhoneNumber = normalizePhoneForCountry(props.user.phoneNumber, inferCountryCodeFromPhone(props.user.phoneNumber));
  const viewDirection = useOrderedPageDirection(view, settingsViewValues);
  const profileHeader = (
    <ProfileIdentityHeader
      displayName={savedDisplayName}
      phoneNumber={savedPhoneNumber}
      imageUrl={props.user.profileImageUrl}
      editable={view === "profile"}
      uploading={props.profileImageUploading}
      onImageSelect={props.onProfileImageUpload}
    />
  );

  useEffect(() => {
    const nextPhoneCountry = inferCountryCodeFromPhone(props.user.phoneNumber);
    setProfile({
      ...props.user,
      phoneNumber: formatPhoneForCountry(props.user.phoneNumber, nextPhoneCountry),
    });
    setProfilePhoneCountry(nextPhoneCountry);
  }, [props.user]);

  const dirtyFields = {
    displayName: profile.displayName !== props.user.displayName,
    phoneNumber: normalizedProfilePhoneNumber !== normalizedSavedPhoneNumber,
    timezone: profile.timezone !== props.user.timezone || profile.timezoneSource !== props.user.timezoneSource,
    location: profile.location !== props.user.location,
    kidsMode: profile.kidsMode !== props.user.kidsMode,
  };

  function handleBackToMenu() {
    props.onHapticFeedback();
    setView("menu");
  }

  function toggleKidsMode() {
    const kidsMode = !profile.kidsMode;
    setProfile({ ...profile, kidsMode });
    props.onSave({ kidsMode }, "kidsMode");
  }

  const sheetTitle = view === "profile" ? "Profile" : view === "settings" ? "Timezone" : "Settings";
  const sheetContent = view === "profile" ? (
        <form className="profile-form" onSubmit={(event) => event.preventDefault()}>
          {profileHeader}
          <ProfileField
            label="Name"
            value={profile.displayName}
            saving={props.saving && props.savingField === "displayName"}
            dirty={dirtyFields.displayName}
            onChange={(displayName) => setProfile({ ...profile, displayName })}
            onSave={() => props.onSave({ displayName: profile.displayName }, "displayName")}
          />
          <ProfilePhoneField
            label="Mobile"
            value={profile.phoneNumber}
            countryCode={profilePhoneCountry}
            saving={props.saving && props.savingField === "phoneNumber"}
            dirty={dirtyFields.phoneNumber}
            onChange={(phoneNumber) => setProfile({ ...profile, phoneNumber })}
            onCountryChange={(countryCode) => {
              setProfilePhoneCountry(countryCode);
              setProfile({ ...profile, phoneNumber: formatPhoneForCountry(profile.phoneNumber, countryCode) });
            }}
            onSave={() => props.onSave({ phoneNumber: normalizedProfilePhoneNumber }, "phoneNumber")}
          />
          <ProfileField
            label="Location"
            value={profile.location}
            saving={props.saving && props.savingField === "location"}
            dirty={dirtyFields.location}
            onChange={(location) => setProfile({ ...profile, location })}
            onSave={() => props.onSave({ location: profile.location }, "location")}
          />
        </form>
  ) : view === "settings" ? (
        <form className="profile-form" onSubmit={(event) => event.preventDefault()}>
          <TimeZoneField
            value={activeTimezone}
            saving={props.saving && props.savingField === "timezone"}
            dirty={dirtyFields.timezone}
            useServerDefault={timezoneUsesServerDefault}
            onSave={() => props.onSave({ timezone: profile.timezone, timezoneSource: profile.timezoneSource }, "timezone")}
            onOpenPicker={() => props.onOpenTimeZonePicker({
              value: activeTimezone,
              onSelect: (timezone) => setProfile({ ...profile, timezone, timezoneSource: "manual" }),
            })}
          />
          <Button
            className="secondary-action compact-action"
            type="button"
            disabled={props.saving || timezoneUsesServerDefault}
            onClick={() => setProfile({ ...profile, timezone: props.user.timezone, timezoneSource: "server" })}
          >
            {timezoneUsesServerDefault ? "Using server timezone" : "Use server timezone"}
          </Button>
        </form>
  ) : (
      <div className="profile-menu">
        {profileHeader}
        <div className="connector-list profile-option-list profile-stack">
          <button
            className="connector-row profile-option-row profile-option-row-joins-next"
            type="button"
            onClick={() => {
              props.onHapticFeedback();
              setView("profile");
            }}
          >
            <span className="connector-row-top">
              <span className="connector-row-head">
                <HugeiconsIcon className="profile-option-icon" icon={UserCircleIcon} size={23} strokeWidth={1.9} aria-hidden="true" />
                <strong className="profile-option-label">Profile</strong>
              </span>
              <HugeiconsIcon className="connector-chevron" icon={ArrowLeft01Icon} size={18} strokeWidth={2.1} aria-hidden="true" />
            </span>
          </button>
          <button
            className="connector-row profile-option-row profile-option-row-joined profile-option-row-joins-next"
            type="button"
            onClick={() => {
              props.onHapticFeedback();
              setView("settings");
            }}
          >
            <span className="connector-row-top">
              <span className="connector-row-head">
                <HugeiconsIcon className="profile-option-icon" icon={Time02Icon} size={23} strokeWidth={1.9} aria-hidden="true" />
                <strong className="profile-option-label">Timezone</strong>
              </span>
              <HugeiconsIcon className="connector-chevron" icon={ArrowLeft01Icon} size={18} strokeWidth={2.1} aria-hidden="true" />
            </span>
          </button>
          <button
            className="connector-row profile-option-row profile-option-row-joined"
            type="button"
            role="switch"
            aria-checked={profile.kidsMode}
            disabled={props.saving && props.savingField === "kidsMode"}
            onClick={toggleKidsMode}
          >
            <span className="connector-row-top">
              <span className="connector-row-head">
                <HugeiconsIcon className="profile-option-icon" icon={ChildIcon} size={23} strokeWidth={1.9} aria-hidden="true" />
                <strong className="profile-option-label">Kids mode</strong>
              </span>
              <span className="profile-toggle" aria-hidden="true" data-state={profile.kidsMode ? "on" : "off"}>
                <span className="profile-toggle-thumb" />
              </span>
            </span>
          </button>
        </div>
        <section className="profile-logout-section" aria-label="Account">
          <div className="connector-list profile-option-list profile-stack">
            <button className="connector-row profile-option-row profile-logout-button" type="button" onClick={props.onLogout}>
              <span className="connector-row-top">
                <span className="connector-row-head">
                  <HugeiconsIcon className="profile-option-icon" icon={Logout04Icon} size={23} strokeWidth={1.9} aria-hidden="true" />
                  <strong className="profile-option-label">Sign out</strong>
                </span>
                <HugeiconsIcon className="connector-chevron" icon={ArrowLeft01Icon} size={18} strokeWidth={2.1} aria-hidden="true" />
              </span>
            </button>
          </div>
        </section>
      </div>
  );

  return (
    <SheetComponent title={sheetTitle} onBack={view === "menu" ? undefined : handleBackToMenu} backLabel={view === "profile" ? "Back to profile menu" : "Back to settings menu"}>
      <PageTransition pageKey={view} direction={viewDirection} className="settings-page-slide">
        {sheetContent}
      </PageTransition>
    </SheetComponent>
  );
}

function ProfilePhoneField(props: {
  label: string;
  value: string;
  countryCode: CountryCode;
  saving: boolean;
  dirty: boolean;
  onChange: (value: string) => void;
  onCountryChange: (value: CountryCode) => void;
  onSave: () => void;
}) {
  const inputId = useId();
  const country = countries.find((item) => item.code === props.countryCode) ?? countries[0];

  return (
    <div className="profile-field">
      <label className="profile-label" htmlFor={inputId}>{props.label}</label>
      <div className="profile-control-row">
        <label className="phone-field profile-phone-input-wrap">
          <span className="country-select-wrap">
            <span className="country-flag">{country.flag}</span>
            <svg className="country-arrow" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 6.25 8 9.75l3.5-3.5" />
            </svg>
            <select
              aria-label="Country"
              value={props.countryCode}
              onChange={(event) => props.onCountryChange(event.target.value as CountryCode)}
            >
              {countries.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.name} {item.prefix}
                </option>
              ))}
            </select>
          </span>
          <span className="divider" />
          <Input
            id={inputId}
            className="phone-input"
            value={props.value}
            onChange={(event) => props.onChange(formatPhoneForCountry(event.target.value, props.countryCode))}
            inputMode="tel"
            autoComplete="tel"
            placeholder={country.placeholder}
          />
        </label>
        {props.dirty ? (
          <Button className="profile-save-inline" type="button" disabled={props.saving} aria-label={`Save ${props.label}`} onClick={props.onSave}>
            {props.saving ? <DashRing className="profile-save-loader" /> : "✓"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ProfileField(props: {
  label: string;
  value: string;
  saving: boolean;
  dirty: boolean;
  inputMode?: "text" | "tel";
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const inputId = useId();

  return (
    <div className="profile-field">
      <label className="profile-label" htmlFor={inputId}>{props.label}</label>
      <div className="profile-control-row">
        <Input
          id={inputId}
          className="profile-input"
          value={props.value}
          inputMode={props.inputMode ?? "text"}
          onChange={(event) => props.onChange(event.target.value)}
        />
        {props.dirty ? (
          <Button className="profile-save-inline" type="button" disabled={props.saving} aria-label={`Save ${props.label}`} onClick={props.onSave}>
            {props.saving ? <DashRing className="profile-save-loader" /> : "✓"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function TimeZoneField(props: {
  value: string;
  saving: boolean;
  dirty: boolean;
  useServerDefault: boolean;
  onSave: () => void;
  onOpenPicker: () => void;
}) {
  return (
    <div className="profile-field timezone-field">
      <span className="profile-label">Timezone</span>
      <div className="profile-control-row">
        <Button
          className={cn("timezone-trigger", props.useServerDefault && "timezone-trigger-muted")}
          disabled={props.saving}
          type="button"
          role="combobox"
          aria-expanded={false}
          onClick={props.onOpenPicker}
        >
          <span className="timezone-trigger-copy">
            <strong>{formatTimeZoneLabel(props.value)}</strong>
          </span>
          <HugeiconsIcon className="timezone-trigger-icon" icon={Search01Icon} size={18} strokeWidth={1.8} />
        </Button>
        {props.dirty ? (
          <Button className="profile-save-inline" type="button" disabled={props.saving} aria-label="Save timezone" onClick={props.onSave}>
            {props.saving ? <DashRing className="profile-save-loader" /> : "✓"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
