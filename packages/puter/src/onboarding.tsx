import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUpRight,
  ChevronRight,
  ChevronsRight,
  Contact,
  ShieldCheck,
} from "lucide-react";
import puterLogoUrl from "./assets/puter_logo@512w.png";
import { CodeInput, PhoneInput, PrimaryButton, SecondaryButton, TextInput } from "./components";
import { countries, formatPhoneForCountry } from "./phone";
import type { CountryCode, SetupStep } from "./types";

export const onboardingSteps: SetupStep[] = [
  {
    id: "full_disk",
    target: "full_disk",
    scopes: ["imessage", "notes"],
    icon: ShieldCheck,
    title: "Grant full disk access",
    body: "Puter needs this to read your iMessages and Notes. Puter will not write, only read.",
    primaryAction: "Open system settings",
    hint: "Click the button above, then enable Puter full disk access. You may be asked to enter your Mac password.",
    pane: "Privacy_AllFiles",
  },
  {
    id: "contacts",
    target: "contacts",
    scopes: ["contacts"],
    icon: Contact,
    title: "Allow Contacts access",
    body: "Puter uses this to better understand your iMessages.",
    primaryAction: "Allow contacts",
    hint: "Click the button above, then click Allow in the popup.",
    pane: "Privacy_Contacts",
  },
];

export function OnboardingHost(props: {
  host: string;
  busy: boolean;
  explicitHttp: boolean;
  onHostChange: (host: string) => void;
  onSubmit: () => void;
}) {
  return (
    <OnboardingPanel media="logo" title="Where does your Finn live?" subtitle="This is the URL/IP address of your Finn server.">
      <form className="onboarding-form" onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}>
        <TextInput value={props.host} placeholder="https://finn.example.app" inputMode="url" autoComplete="url" onChange={props.onHostChange} />
        {props.explicitHttp ? (
          <p className="onboarding-note">HTTP is only for trusted private networks. Use HTTPS for public Finn hosts.</p>
        ) : null}
        <PrimaryButton type="submit" loading={props.busy} disabled={!props.host.trim()}>
          Continue
          <ChevronRight aria-hidden="true" size={15} strokeWidth={2} />
        </PrimaryButton>
      </form>
    </OnboardingPanel>
  );
}

export function OnboardingLogin(props: {
  phoneNumber: string;
  countryCode: CountryCode;
  busy: boolean;
  onPhoneNumberChange: (phoneNumber: string) => void;
  onCountryChange: (countryCode: CountryCode) => void;
  onSubmit: () => void;
}) {
  const country = countries.find((item) => item.code === props.countryCode) ?? countries[0];
  return (
    <OnboardingPanel media="logo" title="What's your mobile?" subtitle="We'll send you a code to verify your account.">
      <form className="onboarding-form" onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}>
        <PhoneInput
          value={props.phoneNumber}
          countryCode={props.countryCode}
          onCountryChange={props.onCountryChange}
          onChange={(value) => props.onPhoneNumberChange(formatPhoneForCountry(value, props.countryCode))}
        />
        <PrimaryButton type="submit" loading={props.busy} disabled={props.phoneNumber.trim().length < Math.min(country.placeholder.length, 6)}>
          Send code
          <ChevronRight aria-hidden="true" size={15} strokeWidth={2} />
        </PrimaryButton>
      </form>
    </OnboardingPanel>
  );
}

export function OnboardingVerify(props: {
  code: string;
  busy: boolean;
  onCodeChange: (code: string) => void;
  onSubmit: () => void;
}) {
  return (
    <OnboardingPanel media="logo" title="Enter your code" subtitle="We sent you an auth code, enter it below.">
      <form className="onboarding-form" onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}>
        <CodeInput value={props.code} maxLength={6} onChange={props.onCodeChange} />
        <PrimaryButton type="submit" loading={props.busy} disabled={props.code.trim().length !== 6}>
          Confirm
          <ChevronRight aria-hidden="true" size={15} strokeWidth={2} />
        </PrimaryButton>
      </form>
    </OnboardingPanel>
  );
}

export function OnboardingPermissionStep(props: {
  step: SetupStep;
  busy: boolean;
  onPrimary: () => void;
  onSkip: () => void;
}) {
  return (
    <OnboardingPanel
      media={props.step.icon}
      title={props.step.title}
      subtitle={props.step.body}
      footer={(
        <button className="skip-step-button" type="button" disabled={props.busy} onClick={props.onSkip}>
          Skip step, setup later
          <ChevronsRight aria-hidden="true" size={15} strokeWidth={2} />
        </button>
      )}
    >
      <div className="onboarding-form">
        <PrimaryButton loading={props.busy} onClick={props.onPrimary}>
          {props.step.primaryAction}
          <ArrowUpRight aria-hidden="true" size={15} strokeWidth={2} />
        </PrimaryButton>
        <p className="permission-hint">{props.step.hint}</p>
      </div>
    </OnboardingPanel>
  );
}

export function OnboardingFinish(props: {
  busy: boolean;
  onGetStarted: () => void;
}) {
  return (
    <OnboardingPanel media={null} title="You're all set!" subtitle="Welcome to Puter.">
      <PrimaryButton loading={props.busy} onClick={props.onGetStarted}>
        Get started
        <ArrowUpRight aria-hidden="true" size={15} strokeWidth={2} />
      </PrimaryButton>
    </OnboardingPanel>
  );
}

export function ConnectionError(props: {
  message: string;
  busy: boolean;
  onRetry: () => void;
  onChangeHost: () => void;
}) {
  return (
    <OnboardingPanel media="logo" title="Could not connect" subtitle={props.message}>
      <div className="button-row">
        <PrimaryButton loading={props.busy} onClick={props.onRetry}>Retry</PrimaryButton>
        <SecondaryButton disabled={props.busy} onClick={props.onChangeHost}>Change URL</SecondaryButton>
      </div>
    </OnboardingPanel>
  );
}

function OnboardingPanel(props: {
  media: LucideIcon | "logo" | null;
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const Icon = props.media === null || props.media === "logo" ? null : props.media;

  return (
    <section className="onboarding-panel">
      {props.media === "logo" ? (
        <img className="onboarding-logo" src={puterLogoUrl} alt="" draggable={false} />
      ) : Icon ? (
        <span className="onboarding-icon" aria-hidden="true">
          <Icon size={20} strokeWidth={2} />
        </span>
      ) : (
        null
      )}
      <div className="onboarding-content">
        <h1>{props.title}</h1>
        <p>{props.subtitle}</p>
        {props.children}
      </div>
      {props.footer}
    </section>
  );
}
