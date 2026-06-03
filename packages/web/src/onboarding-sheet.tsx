import {
  ActivitySparkIcon,
  AiBrain01Icon,
  Calendar02Icon,
  File02Icon,
  Location09Icon,
  Refresh01Icon,
  Share07Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "react-hot-toast";

import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { ConnectorLogo } from "./connector-glyph";
import { cn } from "./lib/utils";
import { LoadingView } from "./loading-view";
import { connectorNameForSlug, getOnboardingConnectorSlugs, onboardingSteps, type OnboardingStep } from "./onboarding-utils";
import { PageTransition, useOrderedPageDirection } from "./page-transition";
import type { Connector, ProfileFieldName, ProfilePatch, UserProfile } from "./web-types";

export function OnboardingSheet(props: {
  user: UserProfile;
  step: OnboardingStep;
  connectors: Connector[];
  connectorLoading: boolean;
  profileSaving: boolean;
  completing: boolean;
  finnPhoneNumber: string;
  SheetComponent: (props: { title: string; children: ReactNode; onBack?: () => void; backLabel?: string; locked?: boolean; className?: string }) => ReactNode;
  onStepChange: (step: OnboardingStep) => void;
  onSaveProfile: (patch: ProfilePatch, field: ProfileFieldName) => Promise<boolean>;
  onSuggestHomeLocation: () => Promise<string | null>;
  onAuthorizeConnector: (slug: string) => void;
  onReloadConnectors: () => void;
  onMessageFinn: () => void;
}) {
  const SheetComponent = props.SheetComponent;
  const suggestHomeLocation = props.onSuggestHomeLocation;
  const [name, setName] = useState(props.user.displayName);
  const [location, setLocation] = useState(props.user.location);
  const [locationLoading, setLocationLoading] = useState(false);
  const locationSuggestionAttemptedRef = useRef(false);

  useEffect(() => {
    setName(props.user.displayName);
    setLocation(props.user.location);
  }, [props.user.id, props.user.displayName, props.user.location]);

  useEffect(() => {
    if (props.step !== "location" || props.user.location.trim() || location.trim() || locationSuggestionAttemptedRef.current) {
      return;
    }

    locationSuggestionAttemptedRef.current = true;
    let cancelled = false;
    setLocationLoading(true);
    suggestHomeLocation()
      .then((suggestion) => {
        if (!cancelled && suggestion) {
          setLocation(suggestion);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setLocationLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [location, props.step, props.user.location, suggestHomeLocation]);

  const requiredSlugs = getOnboardingConnectorSlugs(props.user);
  const connectorRows = requiredSlugs.map((slug) => {
    const connector = props.connectors.find((item) => item.slug === slug);
    return {
      slug,
      name: connector?.name ?? connectorNameForSlug(slug),
      logo: connector?.logo,
      connected: connector?.connected ?? false,
      available: Boolean(connector),
    };
  });
  const availableConnectorRows = connectorRows.filter((connector) => connector.available);
  const connectedConnectorCount = connectorRows.filter((connector) => connector.connected).length;
  const canContinueFromConnect = connectedConnectorCount > 0 || (!props.connectorLoading && availableConnectorRows.length === 0);
  const nextProfileStep = props.user.location.trim() ? "connect" : "location";
  const textFinnDisabled = !props.finnPhoneNumber || props.completing;
  const currentStepIndex = onboardingSteps.indexOf(props.step);
  const stepDirection = useOrderedPageDirection(props.step, onboardingSteps);

  async function saveName() {
    const displayName = name.trim();
    if (!displayName) {
      toast.error("Enter your name.");
      return;
    }
    if (await props.onSaveProfile({ displayName }, "displayName")) {
      props.onStepChange(nextProfileStep);
    }
  }

  async function saveLocation() {
    const homeLocation = location.trim();
    if (!homeLocation) {
      toast.error("Enter your home location.");
      return;
    }
    if (await props.onSaveProfile({ location: homeLocation }, "location")) {
      props.onStepChange("connect");
    }
  }

  async function refreshLocationSuggestion() {
    setLocationLoading(true);
    try {
      const suggestion = await suggestHomeLocation();
      if (suggestion) {
        setLocation(suggestion);
      } else {
        toast.error("Could not detect your location.");
      }
    } finally {
      setLocationLoading(false);
    }
  }

  return (
    <SheetComponent title="Welcome" locked className="onboarding-sheet">
      <div className="onboarding-flow" data-step={props.step}>
        <div className="onboarding-progress" aria-hidden="true">
          {onboardingSteps.map((step, index) => (
            <span key={step} data-active={step === props.step || undefined} data-complete={index < currentStepIndex || undefined} />
          ))}
        </div>

        <PageTransition pageKey={props.step} direction={stepDirection} className="onboarding-stage">
          {props.step === "welcome" ? (
            <section className="onboarding-panel onboarding-step-panel">
              <div className="onboarding-copy onboarding-copy-large">
                <h3>Let's get you settled.</h3>
                <p>A couple of details help things feel like yours from the first message.</p>
              </div>
              <Button className="onboarding-primary-action" type="button" onClick={() => props.onStepChange(props.user.displayName.trim() ? nextProfileStep : "name")}>
                Continue
              </Button>
            </section>
          ) : null}

          {props.step === "name" ? (
            <form
              className="onboarding-panel onboarding-step-panel"
              onSubmit={(event) => {
                event.preventDefault();
                void saveName();
              }}
            >
              <div className="onboarding-copy">
                <h3>What should I call you?</h3>
                <p>Use whatever feels natural. You can change it any time.</p>
              </div>
              <label className="onboarding-field">
                <span>Name</span>
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Tim Apple" autoFocus />
              </label>
              <Button className="onboarding-primary-action" type="submit" disabled={props.profileSaving || !name.trim()}>
                {props.profileSaving ? "Saving..." : "Continue"}
              </Button>
            </form>
          ) : null}

          {props.step === "location" ? (
            <form
              className="onboarding-panel onboarding-step-panel"
              onSubmit={(event) => {
                event.preventDefault();
                void saveLocation();
              }}
            >
              <div className="onboarding-copy">
                <h3>Where is home?</h3>
                <p>Suburb and country is enough. I use this for time, weather, and local context.</p>
              </div>
              <label className="onboarding-field">
                <span>Home location</span>
                <Input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Brisbane, Australia" autoFocus />
              </label>
              <div className="onboarding-action-row onboarding-action-row-icon">
                <button
                  className="onboarding-secondary-action onboarding-icon-action"
                  type="button"
                  aria-label="Use current location"
                  disabled={locationLoading}
                  onClick={() => void refreshLocationSuggestion()}
                >
                  <HugeiconsIcon icon={Location09Icon} size={20} strokeWidth={2} aria-hidden="true" />
                </button>
                <Button className="onboarding-primary-action" type="submit" disabled={props.profileSaving || !location.trim()}>
                  {props.profileSaving ? "Saving..." : "Continue"}
                </Button>
              </div>
            </form>
          ) : null}

          {props.step === "connect" ? (
            <section className="onboarding-panel onboarding-step-panel">
              <div className="onboarding-copy">
                <h3>Connect mail.</h3>
                <p>Choose Gmail, Outlook, or both. I can start with one, and you can add the other later.</p>
              </div>
              <div className="onboarding-connector-list">
                {props.connectorLoading ? <LoadingView label="Loading connectors..." /> : null}
                {!props.connectorLoading && connectorRows.map((connector, index) => (
                  <div
                    className={cn(
                      "connector-row onboarding-connector-row",
                      index > 0 && "connector-row-joined",
                      index < connectorRows.length - 1 && "connector-row-joins-next",
                      connector.connected && "onboarding-connector-connected",
                    )}
                    key={connector.slug}
                  >
                    <span className="connector-row-top">
                      <span className="connector-row-head">
                        <ConnectorLogo src={connector.logo} fallback={connector.name.slice(0, 1)} />
                        <strong>{connector.name}</strong>
                        {connector.connected ? <span className="status-dot connected" /> : null}
                      </span>
                      {connector.connected ? (
                        <span className="onboarding-connected-label">Connected</span>
                      ) : (
                        <button className="onboarding-connect-button" type="button" disabled={!connector.available} onClick={() => props.onAuthorizeConnector(connector.slug)}>
                          {connector.available ? "Connect" : "Unavailable"}
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
              {!props.connectorLoading && availableConnectorRows.length === 0 ? (
                <p className="onboarding-note">Mail connector setup is not available in this deployment. You can finish setup and connect mail later when Composio is configured.</p>
              ) : (
                <p className="onboarding-note">Stay on this step after connecting one account if you want to add the other.</p>
              )}
              <div className="onboarding-action-row onboarding-action-row-icon">
                <button className="onboarding-secondary-action onboarding-icon-action" type="button" aria-label="Refresh connector status" onClick={props.onReloadConnectors}>
                  <HugeiconsIcon icon={Refresh01Icon} size={20} strokeWidth={2} aria-hidden="true" />
                </button>
                <Button className="onboarding-primary-action" type="button" disabled={!canContinueFromConnect} onClick={() => props.onStepChange("finish")}>
                  Continue
                </Button>
              </div>
            </section>
          ) : null}

          {props.step === "finish" ? (
            <section className="onboarding-panel onboarding-step-panel">
              <div className="onboarding-copy onboarding-copy-large">
                <h3>You're ready.</h3>
                <p>I'm personal intelligence for everyday life: a clearer sense of your day, the people and details that matter, and the context you choose to bring along.</p>
                <p>Start with a message. Over time, I learn your rhythm and stay quietly close to the things you would rather not keep in your head.</p>
              </div>
              <div className="onboarding-feature-list" aria-label="What I can help with">
                <span><HugeiconsIcon icon={Calendar02Icon} size={18} strokeWidth={1.9} aria-hidden="true" />My Day</span>
                <span><HugeiconsIcon icon={AiBrain01Icon} size={18} strokeWidth={1.9} aria-hidden="true" />Personal Intelligence</span>
                <span><HugeiconsIcon icon={File02Icon} size={18} strokeWidth={1.9} aria-hidden="true" />Workspace</span>
                <span><HugeiconsIcon icon={Share07Icon} size={18} strokeWidth={1.9} aria-hidden="true" />Connectors</span>
                <span><HugeiconsIcon icon={ActivitySparkIcon} size={18} strokeWidth={1.9} aria-hidden="true" />Patterns</span>
              </div>
              <Button className="onboarding-primary-action" type="button" disabled={textFinnDisabled} onClick={props.onMessageFinn}>
                {props.completing ? "Opening..." : "Message Finn"}
              </Button>
            </section>
          ) : null}
        </PageTransition>
      </div>
    </SheetComponent>
  );
}
