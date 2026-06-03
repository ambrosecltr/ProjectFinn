import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpRight,
  BadgeCheck,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { countries } from "./phone";
import type { CountryCode } from "./types";
import type { SettingsTab } from "./types";

export function SegmentedTabs(props: {
  tabs: { id: SettingsTab; label: string }[];
  activeTab: SettingsTab;
  onChange: (tab: SettingsTab) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<SettingsTab, HTMLButtonElement>());
  const [indicator, setIndicator] = useState({ x: 7, width: 0, ready: false });

  useLayoutEffect(() => {
    const measure = () => {
      const container = containerRef.current;
      const activeTab = tabRefs.current.get(props.activeTab);
      if (!container || !activeTab) {
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const tabRect = activeTab.getBoundingClientRect();
      setIndicator({
        x: tabRect.left - containerRect.left,
        width: tabRect.width,
        ready: true,
      });
    };

    measure();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (containerRef.current && resizeObserver) {
      resizeObserver.observe(containerRef.current);
    }
    globalThis.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      globalThis.removeEventListener("resize", measure);
    };
  }, [props.activeTab, props.tabs]);

  const indicatorStyle = {
    "--indicator-x": `${indicator.x}px`,
    "--indicator-width": `${indicator.width}px`,
  } as CSSProperties;

  return (
    <div className="segmented-tabs" ref={containerRef} role="tablist" aria-label="Puter settings" data-active-tab={props.activeTab} style={indicatorStyle}>
      <span className="segmented-tab-indicator" aria-hidden="true" data-ready={indicator.ready} />
      {props.tabs.map((tab) => (
        <button
          key={tab.id}
          ref={(element) => {
            if (element) {
              tabRefs.current.set(tab.id, element);
            } else {
              tabRefs.current.delete(tab.id);
            }
          }}
          className="segmented-tab"
          type="button"
          role="tab"
          aria-selected={tab.id === props.activeTab}
          data-active={tab.id === props.activeTab}
          onClick={() => props.onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function PrimaryButton(props: {
  children: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  type?: "button" | "submit";
  onClick?: () => void;
}) {
  return (
    <button className="puter-button puter-primary-button" type={props.type ?? "button"} disabled={props.disabled || props.loading} data-loading={props.loading} onClick={props.onClick}>
      {props.loading ? <ButtonLoader /> : null}
      {props.children}
    </button>
  );
}

export function SecondaryButton(props: {
  children: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  type?: "button" | "submit";
  onClick?: () => void;
}) {
  return (
    <button className="puter-button puter-secondary-button" type={props.type ?? "button"} disabled={props.disabled || props.loading} data-loading={props.loading} onClick={props.onClick}>
      {props.loading ? <ButtonLoader /> : null}
      {props.children}
    </button>
  );
}

export function TextInput(props: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  inputMode?: "numeric" | "tel" | "url";
  maxLength?: number;
  autoComplete?: string;
  className?: string;
}) {
  return (
    <label className={`puter-text-field ${props.className ?? ""}`}>
      <input
        className="ui-input"
        value={props.value}
        inputMode={props.inputMode}
        maxLength={props.maxLength}
        autoComplete={props.autoComplete}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </label>
  );
}

export function CodeInput(props: {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
}) {
  const maxLength = props.maxLength ?? 6;
  const digits = props.value.padEnd(maxLength, " ").slice(0, maxLength).split("");

  return (
    <label className="code-input">
      <input
        className="code-input-native"
        value={props.value}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={maxLength}
        onChange={(event) => props.onChange(event.currentTarget.value.replace(/\D/g, "").slice(0, maxLength))}
      />
      <span className="code-digits" aria-hidden="true">
        {digits.map((digit, index) => (
          <span className="code-digit" data-empty={digit === " "} key={index}>
            {digit === " " ? "" : digit}
          </span>
        ))}
      </span>
    </label>
  );
}

export function PhoneInput(props: {
  value: string;
  countryCode: CountryCode;
  onChange: (value: string) => void;
  onCountryChange: (value: CountryCode) => void;
}) {
  const country = countries.find((item) => item.code === props.countryCode) ?? countries[0];
  return (
    <label className="puter-text-field phone-field">
      <span className="country-select-wrap">
        <span className="country-code">{country.flag}</span>
        <ChevronDown aria-hidden="true" size={11} strokeWidth={2} />
        <select
          aria-label="Country"
          value={props.countryCode}
          onChange={(event) => props.onCountryChange(event.currentTarget.value as CountryCode)}
        >
          {countries.map((item) => (
            <option key={item.code} value={item.code}>
              {item.name} {item.prefix}
            </option>
          ))}
        </select>
      </span>
      <span className="phone-divider" aria-hidden="true" />
      <input
        className="ui-input phone-input"
        value={props.value}
        inputMode="tel"
        autoComplete="tel"
        placeholder={country.placeholder}
        onChange={(event) => props.onChange(event.currentTarget.value)}
      />
    </label>
  );
}

export function SourceAccessRow(props: {
  icon: LucideIcon;
  title: string;
  description: string;
  enabled: boolean;
  available: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
  onConfigure: () => void;
}) {
  const Icon = props.icon;

  return (
    <section className="settings-row source-access-row" data-unavailable={!props.available}>
      <span className="row-icon" aria-hidden="true">
        <Icon size={20} strokeWidth={2} />
      </span>
      <div className="settings-row-copy">
        <h2>{props.title}</h2>
        <p>{props.description}</p>
      </div>
      {props.available ? (
        <Switch checked={props.enabled} disabled={props.disabled} onChange={props.onToggle} />
      ) : (
        <ConfigureButton disabled={props.disabled} onClick={props.onConfigure} />
      )}
    </section>
  );
}

export function PersonalIntelligenceRow(props: {
  title: string;
  description: string;
  enabled: boolean;
  available: boolean;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <section className="settings-row pi-row" data-unavailable={!props.available}>
      <div className="settings-row-copy">
        <h2>{props.title}</h2>
        <p>{props.description}</p>
      </div>
      <Switch checked={props.enabled} disabled={props.disabled || !props.available} onChange={props.onToggle} />
    </section>
  );
}

export function PermissionRow(props: {
  target: "full_disk" | "contacts" | "accessibility";
  title: string;
  description: string;
  granted: boolean;
  disabled: boolean;
  highlighted?: boolean;
  onGrant: () => void;
}) {
  return (
    <section className="settings-row permission-row" data-target={props.target} data-highlighted={props.highlighted} data-granted={props.granted}>
      <div className="settings-row-copy">
        <h2>{props.title}</h2>
        <p>{props.description}</p>
      </div>
      {props.granted ? (
        <span className="permission-check" aria-label={`${props.title} granted`}>
          <BadgeCheck size={20} strokeWidth={2} />
        </span>
      ) : (
        <button className="configure-button permission-grant-button" type="button" disabled={props.disabled} onClick={props.onGrant}>
          Grant access
          <ArrowUpRight aria-hidden="true" size={15} strokeWidth={2} />
        </button>
      )}
    </section>
  );
}

export function StatusPill(props: {
  connected: boolean;
  label?: string;
}) {
  return (
    <p className="connection-pill" data-state={props.connected ? "connected" : "disconnected"}>
      <span aria-hidden="true" />
      {props.label ?? (props.connected ? "Connected" : "Reconnecting")}
    </p>
  );
}

export function Switch(props: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      className="switch-button"
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <SwitchVisual checked={props.checked} />
    </button>
  );
}

export function SwitchVisual(props: {
  checked: boolean;
}) {
  return (
    <span className="switch-visual" data-state={props.checked ? "on" : "off"}>
      <span />
    </span>
  );
}

function ConfigureButton(props: {
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="configure-button" type="button" disabled={props.disabled} onClick={props.onClick}>
      Configure
      <ChevronRight aria-hidden="true" size={15} strokeWidth={2} />
    </button>
  );
}

function ButtonLoader() {
  return <span className="button-loader" aria-hidden="true" />;
}
