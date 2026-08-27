interface FormField {
  name: string;
  label: string;
  type: 'text' | 'email' | 'tel' | 'number' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'date';
  required?: boolean;
  options?: string[];
  placeholder?: string;
}

export type { FormField };

export function FormFieldControl({
  field,
  value,
  onChange,
  onComplete,
  inputCls,
}: {
  field: FormField;
  value: string | string[] | undefined;
  onChange: (name: string, v: string | string[]) => void;
  onComplete: (name: string, value: string | string[]) => void;
  inputCls: string;
}) {
  if (field.type === 'textarea') {
    return (
      <textarea
        rows={3}
        placeholder={field.placeholder}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(field.name, e.target.value)}
        onBlur={(e) => onComplete(field.name, e.target.value)}
        className={`mt-1 ${inputCls}`}
      />
    );
  }
  if (field.type === 'select') {
    return (
      <select
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => {
          onChange(field.name, e.target.value);
          onComplete(field.name, e.target.value);
        }}
        className={`mt-1 ${inputCls}`}
      >
        <option value="">選択してください</option>
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  if (field.type === 'radio') {
    return (
      <div className="mt-1 space-y-1.5">
        {(field.options ?? []).map((o) => (
          <label key={o} className="flex items-center gap-2">
            <input
              type="radio"
              name={field.name}
              checked={value === o}
              onChange={() => {
                onChange(field.name, o);
                onComplete(field.name, o);
              }}
            />
            <span>{o}</span>
          </label>
        ))}
      </div>
    );
  }
  if (field.type === 'checkbox') {
    const cur = Array.isArray(value) ? value : [];
    return (
      <div className="mt-1 space-y-1.5">
        {(field.options ?? []).map((o) => (
          <label key={o} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={cur.includes(o)}
              onChange={(e) => {
                const next = e.target.checked
                  ? [...cur, o]
                  : cur.filter((x) => x !== o);
                onChange(field.name, next);
                onComplete(field.name, next);
              }}
            />
            <span>{o}</span>
          </label>
        ))}
      </div>
    );
  }
  return (
    <input
      type={field.type}
      placeholder={field.placeholder}
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(field.name, e.target.value)}
      onBlur={(e) => onComplete(field.name, e.target.value)}
      className={`mt-1 ${inputCls}`}
    />
  );
}
