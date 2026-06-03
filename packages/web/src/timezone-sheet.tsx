import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./components/ui/command";
import { formatTimeZoneLabel, getTimeZoneKeywords, listSupportedTimeZones } from "./lib/timezones";
import { StandaloneSheet } from "./sheet-shell";

const supportedTimeZones = listSupportedTimeZones();

function TimeZonePicker(props: {
  value: string;
  onSelect: (value: string) => void;
}) {
  return (
    <div className="timezone-picker">
      <Command shouldFilter>
        <CommandInput placeholder="Search timezone" autoFocus />
        <CommandList className="timezone-sheet-list">
          <CommandEmpty>No timezone found.</CommandEmpty>
          <CommandGroup>
            {supportedTimeZones.map((timeZone) => (
              <CommandItem
                key={timeZone}
                value={getTimeZoneKeywords(timeZone).join(" ")}
                onSelect={() => props.onSelect(timeZone)}
              >
                <span className="timezone-option-copy">
                  <strong>{formatTimeZoneLabel(timeZone)}</strong>
                  <small>{timeZone}</small>
                </span>
                {props.value === timeZone ? <span className="timezone-option-check">✓</span> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </div>
  );
}

export function TimeZoneSheet(props: {
  value: string;
  onClose: () => void;
  onSelect: (value: string) => void;
}) {
  return (
    <StandaloneSheet title="Timezone" className="timezone-sheet" onClose={props.onClose}>
      <TimeZonePicker value={props.value} onSelect={props.onSelect} />
    </StandaloneSheet>
  );
}
