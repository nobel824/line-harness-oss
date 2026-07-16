'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import type { FormField, FormFieldType } from '@/lib/api'

/** 選択肢(options)の編集UIを持つ設問タイプ。 */
const OPTION_TYPES: ReadonlySet<FormFieldType> = new Set(['select', 'radio', 'checkbox'])

const FIELD_TYPE_LABELS: Record<FormFieldType, string> = {
  text: 'テキスト(1行)',
  textarea: 'テキスト(複数行)',
  number: '数値',
  tel: '電話番号',
  email: 'メールアドレス',
  date: '日付',
  select: 'プルダウン選択',
  radio: 'ラジオボタン(単一選択)',
  checkbox: 'チェックボックス(複数選択)',
}

const FIELD_TYPES = Object.keys(FIELD_TYPE_LABELS) as FormFieldType[]

/** 設問行の編集用ドラフト。`key` は React 用の安定キーでサーバには送らない。 */
export interface FormFieldDraft {
  key: string
  name: string
  label: string
  type: FormFieldType
  required: boolean
  options: string[]
  placeholder: string
  /**
   * 編集UIには入力欄を設けないが、既存フォームの値を保存時に失わないよう往復させる。
   * PUT は fields 配列を丸ごと置換するため、ここで保持しないと既存の 2 列表示設定が消える。
   */
  columns?: number
}

export interface FormDraft {
  id?: string
  name: string
  description: string
  isActive: boolean
  saveToMetadata: boolean
  fields: FormFieldDraft[]
}

export function newFieldDraft(): FormFieldDraft {
  return {
    key: crypto.randomUUID(),
    name: '',
    label: '',
    type: 'text',
    required: false,
    options: [],
    placeholder: '',
  }
}

interface Props {
  draft: FormDraft
  onClose: () => void
  onSaved: () => void
}

export default function FormEditDialog({ draft, onClose, onSaved }: Props) {
  const [name, setName] = useState(draft.name)
  const [description, setDescription] = useState(draft.description)
  const [isActive, setIsActive] = useState(draft.isActive)
  const [saveToMetadata, setSaveToMetadata] = useState(draft.saveToMetadata)
  const [fields, setFields] = useState<FormFieldDraft[]>(draft.fields)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const updateField = (index: number, updates: Partial<FormFieldDraft>) => {
    setFields((prev) => prev.map((f, i) => (i === index ? { ...f, ...updates } : f)))
  }

  const removeField = (index: number) => {
    setFields((prev) => prev.filter((_, i) => i !== index))
  }

  const addField = () => {
    setFields((prev) => [...prev, newFieldDraft()])
  }

  const moveField = (index: number, direction: -1 | 1) => {
    setFields((prev) => {
      const target = index + direction
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const tmp = next[index]
      next[index] = next[target]
      next[target] = tmp
      return next
    })
  }

  const updateOption = (fieldIndex: number, optionIndex: number, value: string) => {
    setFields((prev) =>
      prev.map((f, i) =>
        i === fieldIndex ? { ...f, options: f.options.map((o, j) => (j === optionIndex ? value : o)) } : f,
      ),
    )
  }

  const addOption = (fieldIndex: number) => {
    setFields((prev) =>
      prev.map((f, i) => (i === fieldIndex ? { ...f, options: [...f.options, ''] } : f)),
    )
  }

  const removeOption = (fieldIndex: number, optionIndex: number) => {
    setFields((prev) =>
      prev.map((f, i) =>
        i === fieldIndex ? { ...f, options: f.options.filter((_, j) => j !== optionIndex) } : f,
      ),
    )
  }

  const handleSave = async () => {
    if (!name.trim()) { setError('フォーム名を入力してください'); return }
    if (fields.length === 0) { setError('設問を1つ以上追加してください'); return }
    for (const f of fields) {
      if (!f.label.trim()) { setError('すべての設問に設問文(label)を入力してください'); return }
    }

    // データキー(name)未入力は自動採番。手入力分はそのままトリムして使う。
    const finalFields: FormField[] = fields.map((f, i) => {
      const finalName = f.name.trim() || `field_${i + 1}`
      const cleanedOptions = f.options.map((o) => o.trim()).filter((o) => o !== '')
      const field: FormField = {
        name: finalName,
        label: f.label.trim(),
        type: f.type,
        required: f.required,
      }
      if (OPTION_TYPES.has(f.type)) field.options = cleanedOptions
      if (f.placeholder.trim()) field.placeholder = f.placeholder.trim()
      if (f.columns !== undefined) field.columns = f.columns
      return field
    })

    for (const f of finalFields) {
      if (OPTION_TYPES.has(f.type) && (!f.options || f.options.length === 0)) {
        setError(`設問「${f.label}」は選択肢(options)を1つ以上追加してください`)
        return
      }
    }

    const names = finalFields.map((f) => f.name)
    const dupe = names.find((n, i) => names.indexOf(n) !== i)
    if (dupe) { setError(`設問のデータキー「${dupe}」が重複しています。名称を変えてください`); return }

    setError('')
    setSaving(true)
    try {
      if (draft.id) {
        await api.forms.update(draft.id, {
          name: name.trim(),
          description: description.trim(),
          fields: finalFields,
          saveToMetadata,
          isActive,
        })
      } else {
        await api.forms.create({
          name: name.trim(),
          description: description.trim(),
          fields: finalFields,
          saveToMetadata,
        })
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました')
    }
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="px-5 py-4 border-b sticky top-0 bg-white z-10">
          <h3 className="text-base font-semibold">{draft.id ? 'フォーム編集' : '新規フォーム'}</h3>
        </div>

        <div className="p-5 space-y-5">
          <div>
            <label className="block text-xs text-gray-600 mb-1">フォーム名</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="例: 友だち追加アンケート"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-600 mb-1">説明</label>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
              placeholder="管理画面用のメモ(任意)"
            />
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              <span className="text-xs text-gray-600">有効</span>
            </label>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={saveToMetadata}
                onChange={(e) => setSaveToMetadata(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              <span className="text-xs text-gray-600">回答を友だちメタデータに保存</span>
            </label>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-gray-700">設問</span>
              <button
                type="button"
                onClick={addField}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                + 設問を追加
              </button>
            </div>

            <div className="space-y-3">
              {fields.map((field, i) => (
                <div key={field.key} className="bg-gray-50 rounded-lg border border-gray-200 p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex flex-col gap-0.5 shrink-0 pt-1">
                      <button
                        type="button"
                        onClick={() => moveField(i, -1)}
                        disabled={i === 0}
                        className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed"
                        aria-label="上へ"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => moveField(i, 1)}
                        disabled={i === fields.length - 1}
                        className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed"
                        aria-label="下へ"
                      >
                        ↓
                      </button>
                    </div>

                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-gray-400 shrink-0 tabular-nums">Q{i + 1}</span>
                        <input
                          type="text"
                          value={field.label}
                          onChange={(e) => updateField(i, { label: e.target.value })}
                          className="flex-1 border border-gray-300 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                          placeholder="設問文（例: 現在の立場は？）"
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={field.type}
                          onChange={(e) => updateField(i, { type: e.target.value as FormFieldType })}
                          className="text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white"
                        >
                          {FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>
                          ))}
                        </select>

                        <input
                          type="text"
                          value={field.name}
                          onChange={(e) => updateField(i, { name: e.target.value })}
                          className="text-xs border border-gray-300 rounded-md px-2 py-1.5 w-32"
                          placeholder={`データキー(空欄=field_${i + 1})`}
                        />

                        <label className="inline-flex items-center gap-1 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={field.required}
                            onChange={(e) => updateField(i, { required: e.target.checked })}
                            className="h-3.5 w-3.5 rounded border-gray-300 text-green-600 focus:ring-green-500"
                          />
                          <span className="text-[11px] text-gray-600">必須</span>
                        </label>

                        <button
                          type="button"
                          onClick={() => removeField(i)}
                          className="ml-auto text-[11px] text-red-500 hover:text-red-700"
                        >
                          設問を削除
                        </button>
                      </div>

                      {OPTION_TYPES.has(field.type) && (
                        <div className="pl-1 space-y-1.5 border-l-2 border-gray-200">
                          <div className="pl-2 text-[11px] text-gray-500">選択肢</div>
                          {field.options.map((opt, oi) => (
                            <div key={oi} className="pl-2 flex items-center gap-1.5">
                              <input
                                type="text"
                                value={opt}
                                onChange={(e) => updateOption(i, oi, e.target.value)}
                                className="flex-1 border border-gray-300 rounded-md px-2 py-1 text-xs"
                                placeholder={`選択肢 ${oi + 1}`}
                              />
                              <button
                                type="button"
                                onClick={() => removeOption(i, oi)}
                                className="text-red-400 hover:text-red-600 text-xs px-1 shrink-0"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() => addOption(i)}
                            className="pl-2 text-[11px] text-blue-600 hover:text-blue-800"
                          >
                            + 選択肢を追加
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {fields.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-4">設問がありません。「+ 設問を追加」から作成してください</p>
              )}
            </div>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t flex gap-2 justify-end sticky bottom-0 bg-white">
          <button onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md">キャンセル</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium text-white rounded-md disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
