import type { ReactNode } from "react";

import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "./components/ui/input-otp";
import { countries, formatPhoneForCountry } from "./phone-utils";
import type { CountryCode } from "./web-types";
import { buildTextFinnHref } from "./web-utils";

export function LoginScreen(props: {
  phoneNumber: string;
  countryCode: CountryCode;
  greeting: string;
  loading: boolean;
  AuthTopBarComponent: () => ReactNode;
  onPhoneChange: (value: string) => void;
  onCountryChange: (value: CountryCode) => void;
  onSubmit: () => void;
}) {
  const AuthTopBarComponent = props.AuthTopBarComponent;
  const country = countries.find((item) => item.code === props.countryCode) ?? countries[0];

  return (
    <main className="auth-screen">
      <AuthTopBarComponent />
      <section className="auth-stack">
        <section className="auth-copy">
          <h1>{props.greeting}</h1>
          <p>What&apos;s your phone number? We&apos;ll send you a code.</p>
        </section>
        <div className="auth-panel">
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              props.onSubmit();
            }}
          >
            <label className="phone-field">
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
                className="phone-input"
                value={props.phoneNumber}
                onChange={(event) => props.onPhoneChange(formatPhoneForCountry(event.target.value, props.countryCode))}
                inputMode="tel"
                autoComplete="tel"
                placeholder={country.placeholder}
              />
            </label>
            <Button className="frost-button" disabled={props.loading || !props.phoneNumber.trim()} type="submit">
              {props.loading ? "Sending..." : "Continue"}
            </Button>
          </form>
        </div>
      </section>
    </main>
  );
}

export function VerifyScreen(props: {
  code: string;
  loading: boolean;
  phoneNumber: string;
  AuthTopBarComponent: () => ReactNode;
  onCodeChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
}) {
  const AuthTopBarComponent = props.AuthTopBarComponent;

  return (
    <main className="auth-screen verify-screen">
      <AuthTopBarComponent />
      <section className="auth-stack">
        <section className="auth-copy">
          <h1>Enter your code</h1>
          <p>Sent to {props.phoneNumber}</p>
        </section>
        <div className="auth-panel verify-panel">
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              props.onSubmit();
            }}
          >
            <InputOTP
              value={props.code}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              onChange={(value) => props.onCodeChange(value.replace(/\D/g, "").slice(0, 6))}
            >
              <InputOTPGroup>
                {Array.from({ length: 6 }, (_, index) => <InputOTPSlot key={index} index={index} />)}
              </InputOTPGroup>
            </InputOTP>
            <div className="verify-actions">
              <Button className="profile-save-inline verify-back-button" type="button" aria-label="Back" onClick={props.onBack}>‹</Button>
              <Button className="frost-button" disabled={props.loading || props.code.length !== 6} type="submit">
                {props.loading ? "Checking..." : "Verify"}
              </Button>
            </div>
          </form>
          <p className="resend-note">Didn’t get it? Request a new code</p>
        </div>
      </section>
    </main>
  );
}

export function SignupHandoffScreen(props: {
  finnPhoneNumber: string;
  AuthTopBarComponent: () => ReactNode;
  onOpenMessages: () => void;
  onContinue: () => void;
}) {
  const AuthTopBarComponent = props.AuthTopBarComponent;
  const textFinnHref = props.finnPhoneNumber ? buildTextFinnHref(props.finnPhoneNumber, "Hey!") : null;

  return (
    <main className="auth-screen signup-handoff-screen">
      <AuthTopBarComponent />
      <section className="auth-stack signup-handoff-stack">
        <section className="auth-copy">
          <h1>Text Finn first.</h1>
          <p>Finn needs your first message before the dashboard can do everything.</p>
        </section>
        <div className="auth-panel signup-handoff-panel">
          {textFinnHref ? (
            <a className="ui-button frost-button signup-message-button" href={textFinnHref} onClick={props.onOpenMessages}>
              Message Finn
            </a>
          ) : (
            <Button className="frost-button signup-message-button" disabled type="button">
              Message Finn
            </Button>
          )}
          <button className="dashboard-continue-button" type="button" onClick={props.onContinue}>
            Continue to dashboard
          </button>
        </div>
      </section>
    </main>
  );
}
