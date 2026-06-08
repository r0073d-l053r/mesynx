"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

interface ToggleSwitchProps {
    checked: boolean;
    onChange?: (checked: boolean) => void;
    label?: string;
    labelPosition?: "left" | "right";
    disabled?: boolean;
    className?: string;
}

export function ToggleSwitch({
    checked,
    onChange,
    label,
    labelPosition = "right",
    disabled = false,
    className,
}: ToggleSwitchProps) {
    const baseId = useId();
    const switchId = `toggle-${baseId}`;
    const labelId = `toggle-label-${baseId}`;

    const handleClick = () => {
        if (!disabled && onChange) {
            onChange(!checked);
        }
    };

    const switchElement = (
        <div
            id={switchId}
            className={cn(
                "toggle-switch",
                checked && "active",
                disabled && "opacity-50 cursor-not-allowed",
                className,
            )}
            onClick={label ? undefined : handleClick}
            role="switch"
            aria-checked={checked}
            aria-disabled={disabled}
            aria-labelledby={label ? labelId : undefined}
            tabIndex={label || disabled ? -1 : 0}
            onKeyDown={
                label
                    ? undefined
                    : (e) => {
                          if (
                              !disabled &&
                              (e.key === "Enter" || e.key === " ")
                          ) {
                              e.preventDefault();
                              handleClick();
                          }
                      }
            }
        >
            <div className="toggle-thumb" />
        </div>
    );

    if (!label) {
        return switchElement;
    }

    const Wrapper = disabled ? "div" : "button";
    const wrapperProps = disabled
        ? {}
        : {
              onClick: handleClick,
              onKeyDown: (e: React.KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleClick();
                  }
              },
              type: "button" as const,
          };

    return (
        <Wrapper
            className={cn(
                "flex items-center gap-3 border-0 bg-transparent p-0",
                !disabled && "cursor-pointer",
                disabled && "cursor-not-allowed",
            )}
            {...wrapperProps}
        >
            {labelPosition === "left" && (
                <span id={labelId} className="text-sm font-medium select-none">
                    {label}
                </span>
            )}
            {switchElement}
            {labelPosition === "right" && (
                <span id={labelId} className="text-sm font-medium select-none">
                    {label}
                </span>
            )}
        </Wrapper>
    );
}
