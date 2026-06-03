import * as React from "react";
import { OTPInput, OTPInputContext, type OTPInputProps } from "input-otp";
import { cn } from "../../lib/utils";

export const InputOTP = React.forwardRef<React.ElementRef<typeof OTPInput>, OTPInputProps>(
  function InputOTP({ className, containerClassName, ...props }, ref) {
    return (
      <OTPInput
        ref={ref}
        containerClassName={cn("ui-input-otp", containerClassName)}
        className={cn("ui-input-otp-field", className)}
        {...props}
      />
    );
  },
);

export const InputOTPGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function InputOTPGroup({ className, ...props }, ref) {
    return <div ref={ref} className={cn("ui-input-otp-group", className)} {...props} />;
  },
);

export const InputOTPSlot = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { index: number }>(
  function InputOTPSlot({ index, className, ...props }, ref) {
    const otpContext = React.useContext(OTPInputContext);
    const slot = otpContext.slots[index];

    return (
      <div
        ref={ref}
        className={cn(
          "ui-input-otp-slot",
          slot.isActive && "ui-input-otp-slot-active",
          className,
        )}
        {...props}
      >
        <span>{slot.char ?? ""}</span>
        {slot.hasFakeCaret ? <span className="ui-input-otp-caret" /> : null}
      </div>
    );
  },
);
