'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { FormField, FormRecord } from '@/lib/api'
import Header from '@/components/layout/header'
import FormEditDialog, { newFieldDraft, type FormDraft } from '@/components/forms/form-edit-dialog'

/** 一覧表示用に fields を必ず配列へ正規化した shape。 */
interface FormListItem extends Omit<FormRecord, 'fields'> {
  fields: FormField[]
}

/** fields が文字列(JSON)で来た場合に備えたガード。form-submissions/page.tsx の前例に合わせる。 */
function parseFields(raw: FormRecord['fields']): FormField[] {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as FormField[]) : []
    } catch {
      return []
    }
  }
  return Array.isArray(raw) ? raw : []
}

function emptyDraft(): FormDraft {
  return {
    name: '',
    description: '',
    isActive: true,
    saveToMetadata: true,
    fields: [newFieldDraft()],
  }
}

function draftFromForm(f: FormListItem): FormDraft {
  return {
    id: f.id,
    name: f.name,
    description: f.description ?? '',
    isActive: f.isActive,
    saveToMetadata: f.saveToMetadata,
    fields:
      f.fields.length > 0
        ? f.fields.map((field) => ({
            key: crypto.randomUUID(),
            name: field.name,
            label: field.label,
            type: field.type,
            required: field.required ?? false,
            options: field.options ?? [],
            placeholder: field.placeholder ?? '',
            columns: field.columns,
          }))
        : [newFieldDraft()],
  }
}

export default function FormsPage() {
  const [items, setItems] = useState<FormListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<FormDraft | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.forms.list()
      if (res.success) {
        setItems(res.data.map((f) => ({ ...f, fields: parseFields(f.fields) })))
      }
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id: string) => {
    if (!confirm('このフォームを削除しますか？回答データは残りますが、フォーム自体は復元できません。')) return
    try {
      await api.forms.delete(id)
      setNotice('削除しました')
      load()
    } catch {
      setError('削除に失敗しました')
    }
  }

  return (
    <div>
      <Header
        title="フォーム管理"
        description="友だち追加アンケート等、稼働中インスタンスのフォーム(設問)を作成・編集・削除します"
        action={
          <button
            onClick={() => { setNotice(''); setEditing(emptyDraft()) }}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規フォーム
          </button>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
          {notice}
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">フォーム名</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">設問数</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">回答数</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">状態</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">読み込み中...</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">フォームがありません</td></tr>
              ) : (
                items.map((f) => (
                  <tr key={f.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">
                      {f.name}
                      {f.description && <p className="text-xs text-gray-400 mt-0.5">{f.description}</p>}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 tabular-nums">{f.fields.length}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 tabular-nums">{f.submitCount ?? 0}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${f.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {f.isActive ? '有効' : '無効'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <button
                        onClick={() => { setNotice(''); setEditing(draftFromForm(f)) }}
                        className="px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded-md"
                      >
                        編集
                      </button>
                      <button
                        onClick={() => handleDelete(f.id)}
                        className="ml-1 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 rounded-md"
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <FormEditDialog
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setNotice(editing.id ? '更新しました' : '作成しました')
            setEditing(null)
            load()
          }}
        />
      )}
    </div>
  )
}
