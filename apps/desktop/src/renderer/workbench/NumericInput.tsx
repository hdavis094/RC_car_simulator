import { useState, type CSSProperties, type ReactNode } from 'react';

export interface NumericInputProps {
  readonly value: number | undefined;
  readonly onChange: (value: number) => void;
  readonly onClear?: () => void;
  readonly ariaLabel?: string;
  readonly 'aria-label'?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number | 'any';
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly style?: CSSProperties;
}

const isIntermediateNumericDraft = (raw: string): boolean => {
  const trimmed = raw.trim();
  return (
    trimmed === '' ||
    trimmed === '-' ||
    trimmed === '+' ||
    trimmed === '.' ||
    trimmed === '-.' ||
    trimmed === '+.'
  );
};

const DECIMAL_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Parses a finite base-10 number, rejecting `Infinity`, overflow (`1e999`),
 * hex (`0x10`), binary (`0b10`), octal (`0o10`), and `NaN`.
 */
export function parseFiniteDecimal(raw: string): number | null {
  const trimmed = raw.trim();
  if (!DECIMAL_NUMBER_RE.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Controlled number input that keeps a string draft while typing so negative
 * signs (`-`), decimal points (`12.`), and clearing an optional field work
 * naturally without snapping to `0`.
 */
export function NumericInput({
  value,
  onChange,
  onClear,
  ariaLabel,
  'aria-label': ariaLabelAttr,
  min,
  max,
  step = 'any',
  disabled,
  placeholder,
  style,
}: NumericInputProps): ReactNode {
  const resolvedAriaLabel = ariaLabel ?? ariaLabelAttr;
  const externalStr = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState<string>(externalStr);
  const [prevValue, setPrevValue] = useState<number | undefined>(value);
  const [focused, setFocused] = useState(false);

  if (value !== prevValue) {
    setPrevValue(value);
    if (!focused) {
      setDraft(externalStr);
    }
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={resolvedAriaLabel}
      disabled={disabled}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => setFocused(true)}
      onChange={(e) => {
        const nextRaw = e.target.value;
        setDraft(nextRaw);
        const trimmed = nextRaw.trim();
        if (trimmed === '') {
          onClear?.();
          return;
        }
        if (isIntermediateNumericDraft(trimmed)) {
          return;
        }
        const parsed = parseFiniteDecimal(trimmed);
        if (parsed !== null) {
          onChange(parsed);
        }
      }}
      onBlur={() => {
        setFocused(false);
        const trimmed = draft.trim();
        if (trimmed === '' && onClear) {
          onClear();
          setDraft('');
          return;
        }
        const parsed = parseFiniteDecimal(trimmed);
        if (trimmed === '' || isIntermediateNumericDraft(trimmed) || parsed === null) {
          setDraft(externalStr);
        } else {
          onChange(parsed);
          setDraft(String(parsed));
        }
      }}
      style={style}
    />
  );
}
