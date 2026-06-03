import { LaptopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

import { cn } from "./lib/utils";

export function ConnectorLogo(props: {
  src?: string;
  fallback: string;
  large?: boolean;
  pill?: boolean;
}) {
  const [showImage, setShowImage] = useState(Boolean(props.src));

  useEffect(() => {
    setShowImage(Boolean(props.src));
  }, [props.src]);

  return (
    <span className={cn("connector-logo", props.large && "large", props.pill && "pill")}>
      {props.src && showImage ? (
        <img
          className="app-image"
          src={props.src}
          alt=""
          draggable={false}
          onError={() => setShowImage(false)}
        />
      ) : props.fallback}
    </span>
  );
}

export function ConnectorGlyph(props: {
  connector: { slug: string; logo?: string; name: string };
  large?: boolean;
  pill?: boolean;
}) {
  if (props.connector.slug === "puter") {
    return (
      <span className={cn("connector-logo", props.large && "large", props.pill && "pill")}>
        <HugeiconsIcon icon={LaptopIcon} size={props.large ? 25 : props.pill ? 14 : 20} strokeWidth={1.9} aria-hidden="true" />
      </span>
    );
  }

  return <ConnectorLogo src={props.connector.logo} fallback={props.connector.name.slice(0, 1)} large={props.large} pill={props.pill} />;
}
