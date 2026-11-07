import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useResource } from '../hooks';
import { useWorkspace } from '../Workspace';
import { Button, ErrorState, Modal, PageHeader, Spinner } from '../components/ui';
import type { ChecklistDraft, CriterionDraft } from './workspace/models';
import { errorMessage, number } from './workspace/logic';
import { Empty, SectionTitle, StatusTag } from './workspace/WorkspaceUi';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function newCriterion(existing: CriterionDraft[], section?: string): CriterionDraft {
  let index = existing.length + 1;
  while (existing.some((criterion) => criterion.id === `c${String(index).padStart(2, '0')}`))
    index++;
  return {
    id: `c${String(index).padStart(2, '0')}`,
    code: String(index).padStart(2, '0'),
    title: 'Новый критерий',
    type: 'binary',
    weight: 10,
    section: section || null,
    description: '',
    na_allowed: false,
  };
}
const blankChecklist = (): ChecklistDraft => ({
  id: '',
  name: 'Новый чек-лист',
  version: 0,
  rounding: 2,
  notes: '',
  sections: [{ id: 'main', name: 'Основные критерии' }],
  criteria: [newCriterion([], 'main')],
});
const typeLabels = { binary: 'Да / Нет', scale: 'Балльная шкала', flag: 'Грубая ошибка' };
const checklistDrafts = new Map<string, ChecklistDraft>();

function CriterionEditor({
  criterion,
  onChange,
  onRemove,
  onMove,
  first,
  last,
  sections,
}: {
  criterion: CriterionDraft;
  onChange: (patch: Partial<CriterionDraft>) => void;
  onRemove: () => void;
  onMove: (direction: number) => void;
  first: boolean;
  last: boolean;
  sections: ChecklistDraft['sections'];
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  return (
    <div className="cqa-criterion-editor">
      <div className="cqa-inline-between">
        <div>
          <span className="cqa-eyebrow">КРИТЕРИЙ {criterion.code || criterion.id}</span>
          <h2>{criterion.title || 'Без названия'}</h2>
        </div>
        <div className="cqa-row-actions">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Переместить критерий выше"
            disabled={first}
            onClick={() => onMove(-1)}
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Переместить критерий ниже"
            disabled={last}
            onClick={() => onMove(1)}
          >
            ↓
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
            Удалить
          </Button>
        </div>
      </div>
      <div className="cqa-editor-fields">
        <label className="cqa-field cqa-field-wide">
          Название критерия
          <input
            value={criterion.title}
            onChange={(e) => onChange({ title: e.target.value })}
            maxLength={500}
          />
        </label>
        <label className="cqa-field">
          Код
          <input
            value={criterion.code || ''}
            onChange={(e) => onChange({ code: e.target.value })}
          />
        </label>
        <label className="cqa-field">
          ID критерия
          <input
            value={criterion.id}
            onChange={(e) => onChange({ id: e.target.value })}
            pattern="[A-Za-z0-9_-]{1,40}"
          />
        </label>
        <label className="cqa-field">
          Тип ответа
          <select
            value={criterion.type}
            onChange={(e) => {
              const type = e.target.value as CriterionDraft['type'];
              onChange({
                type,
                ...(type === 'flag' ? { weight: 0, na_allowed: false } : {}),
                ...(type === 'scale' && !criterion.scale
                  ? {
                      scale: [
                        { value: 10, description: 'Выполнено полностью' },
                        { value: 5, description: 'Выполнено частично' },
                        { value: 0, description: 'Не выполнено' },
                      ],
                    }
                  : {}),
              });
            }}
          >
            {Object.entries(typeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="cqa-field">
          Вес
          <input
            type="number"
            min={0}
            step="any"
            value={criterion.weight}
            disabled={criterion.type === 'flag'}
            onChange={(e) =>
              onChange({ weight: e.target.value === '' ? 0 : Number(e.target.value) })
            }
          />
        </label>
        <label className="cqa-field cqa-field-wide">
          Секция
          <select
            value={criterion.section || ''}
            onChange={(e) => onChange({ section: e.target.value || null })}
          >
            <option value="">Без секции</option>
            {sections.map((section, index) => (
              <option key={index} value={section.id}>
                {section.name}
              </option>
            ))}
          </select>
        </label>
        <label className="cqa-field cqa-field-wide">
          Правило оценки
          <textarea
            rows={5}
            value={criterion.description || ''}
            onChange={(e) => onChange({ description: e.target.value })}
            placeholder="Опишите, что должен проверить ИИ и какие доказательства искать"
          />
        </label>
      </div>
      {criterion.type !== 'flag' && (
        <div className="cqa-na-editor">
          <label className="cqa-checkbox-label">
            <input
              type="checkbox"
              checked={!!criterion.na_allowed}
              onChange={(e) => onChange({ na_allowed: e.target.checked })}
            />
            Разрешить N/A
          </label>
          <p className="cqa-cell-muted">
            Неприменимый критерий исключается из знаменателя итогового балла.
          </p>
          {criterion.na_allowed && (
            <label className="cqa-field">
              Условие N/A
              <textarea
                rows={2}
                value={criterion.na_condition || ''}
                onChange={(e) => onChange({ na_condition: e.target.value })}
                placeholder="Когда критерий неприменим к диалогу"
              />
            </label>
          )}
        </div>
      )}
      {criterion.type === 'flag' && (
        <div className="cqa-inline-notice">
          Грубая ошибка фиксируется отдельно и не входит в сумму весов.
        </div>
      )}
      {criterion.type === 'scale' && (
        <div className="cqa-scale-editor">
          <SectionTitle
            title="Ступени шкалы"
            description="Максимальная ступень соответствует полному весу критерия"
          />
          {(criterion.scale || []).map((step, index) => (
            <div className="cqa-scale-step" key={index}>
              <label className="cqa-field">
                Баллы
                <input
                  type="number"
                  min={0}
                  step="any"
                  aria-label={`Баллы ступени ${index + 1}`}
                  value={step.value}
                  onChange={(e) =>
                    onChange({
                      scale: criterion.scale!.map((item, key) =>
                        key === index ? { ...item, value: Number(e.target.value) } : item,
                      ),
                    })
                  }
                />
              </label>
              <label className="cqa-field">
                Описание
                <input
                  aria-label={`Описание ступени ${index + 1}`}
                  value={step.description}
                  onChange={(e) =>
                    onChange({
                      scale: criterion.scale!.map((item, key) =>
                        key === index ? { ...item, description: e.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <button
                className="cqa-icon-action"
                aria-label={`Удалить ступень ${index + 1}`}
                onClick={() =>
                  onChange({ scale: criterion.scale!.filter((_, key) => key !== index) })
                }
              >
                ×
              </button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              onChange({ scale: [...(criterion.scale || []), { value: 0, description: '' }] })
            }
          >
            Добавить ступень
          </Button>
        </div>
      )}
      {confirmRemove && (
        <Modal
          title="Удалить критерий?"
          onClose={() => setConfirmRemove(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmRemove(false)}>
                Отмена
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirmRemove(false);
                  onRemove();
                }}
              >
                Удалить
              </Button>
            </>
          }
        >
          <p>
            Критерий «{criterion.title}» будет удалён из черновика. Изменение вступит в силу после
            сохранения.
          </p>
        </Modal>
      )}
    </div>
  );
}
export default function ChecklistsPage() {
  const { checklists, checklistId, setChecklistId, refreshBase, notify } = useWorkspace();
  const resource = useResource<ChecklistDraft>(`checklist:${checklistId}`, (signal) =>
    api.get(`/checklists/${encodeURIComponent(checklistId)}`, signal),
  );
  const [draft, setDraft] = useState<ChecklistDraft | null>(null),
    [selected, setSelected] = useState(0),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState('');
  const [confirm, setConfirm] = useState<'reset' | 'delete' | null>(null),
    [pendingSwitch, setPendingSwitch] = useState<string | null>(null),
    [copying, setCopying] = useState(false);
  const drafts = useRef(checklistDrafts);
  useEffect(() => {
    if (resource.data) {
      const data = resource.data;
      setDraft(clone(drafts.current.get(`${data.id}:${data.version}`) || data));
      setSelected(0);
      setSaveError('');
    }
  }, [resource.data]);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(resource.data);
  useEffect(() => {
    if (!dirty || !draft) return;
    drafts.current.set(`${draft.id}:${draft.version}`, clone(draft));
  }, [draft, dirty]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  function update(patch: Partial<ChecklistDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }
  function criterionChange(patch: Partial<CriterionDraft>) {
    if (!draft) return;
    update({
      criteria: draft.criteria.map((criterion, index) =>
        index === selected ? { ...criterion, ...patch } : criterion,
      ),
    });
  }
  async function save(asNew = false) {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const saved = await (asNew || !draft.id
        ? api.post<ChecklistDraft>('/checklists', draft)
        : api.put<ChecklistDraft>(`/checklists/${encodeURIComponent(draft.id)}`, draft));
      drafts.current.delete(`${draft.id}:${draft.version}`);
      setDraft(saved);
      await refreshBase();
      setChecklistId(saved.id);
      resource.reload();
      setCopying(false);
      notify(`Сохранён чек-лист · v${saved.version}`, 'success');
    } catch (cause) {
      setSaveError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (!draft || saving) return;
    setSaving(true);
    try {
      await api.delete(`/checklists/${encodeURIComponent(draft.id)}`);
      await refreshBase();
      setChecklistId('default');
      setConfirm(null);
      notify('Чек-лист удалён', 'success');
    } catch (cause) {
      notify(errorMessage(cause), 'error');
    } finally {
      setSaving(false);
    }
  }
  function activateChecklist(id: string) {
    setCopying(false);
    setChecklistId(id);
    if (id === checklistId && resource.data) {
      setDraft(clone(drafts.current.get(`${id}:${resource.data.version}`) || resource.data));
      setSelected(0);
    }
  }
  function switchChecklist(id: string) {
    if (dirty) {
      setPendingSwitch(id);
      return;
    }
    activateChecklist(id);
  }
  function startNew() {
    if (dirty) {
      setPendingSwitch('__new__');
      return;
    }
    setDraft(blankChecklist());
    setCopying(true);
    setSelected(0);
  }
  function switchConfirmed() {
    const next = pendingSwitch;
    setPendingSwitch(null);
    if (next === '__new__') {
      setDraft(blankChecklist());
      setCopying(true);
      setSelected(0);
    } else if (next) activateChecklist(next);
  }
  const sum =
    draft?.criteria.reduce(
      (total, criterion) => total + (criterion.type === 'flag' ? 0 : Number(criterion.weight) || 0),
      0,
    ) || 0;
  const selectedCriterion = draft?.criteria[selected];
  return (
    <div className="cqa-workspace-page">
      <PageHeader title="Чек-листы" subtitle="Прозрачные правила, веса и версии оценки">
        <Button variant="secondary" onClick={startNew}>
          Новый чек-лист
        </Button>
        <Button
          variant="primary"
          loading={saving}
          disabled={!draft || (!dirty && !copying)}
          onClick={() => void save(copying)}
        >
          {copying ? 'Сохранить новый' : 'Сохранить версию'}
        </Button>
      </PageHeader>
      <div className="cqa-page-scroll cqa-workspace-content">
        {resource.error && !draft ? (
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : !draft ? (
          <div className="cqa-workspace-loading">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="cqa-checklist-toolbar">
              <label className="cqa-field cqa-checklist-picker">
                Открыть чек-лист
                <select
                  value={copying ? '__new__' : checklistId}
                  onChange={(e) => switchChecklist(e.target.value)}
                >
                  {copying && <option value="__new__">Новый чек-лист</option>}
                  {checklists.map((checklist) => (
                    <option key={checklist.id} value={checklist.id}>
                      {checklist.name} · v{checklist.version}
                    </option>
                  ))}
                </select>
              </label>
              <div className="cqa-inline-tags">
                <StatusTag tone={dirty ? 'warning' : 'success'}>
                  {dirty ? 'Есть изменения' : 'Сохранено'}
                </StatusTag>
                <span className="cqa-cell-muted">
                  {draft.id ? `v${draft.version}` : 'Новый'} · {draft.criteria.length} критериев
                </span>
              </div>
              <div className="cqa-row-actions">
                <Button
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    setDraft({
                      ...clone(draft),
                      id: '',
                      name: `${draft.name} — копия`,
                      version: 0,
                    });
                    setCopying(true);
                  }}
                >
                  Создать копию
                </Button>
                <Button
                  variant="ghost"
                  disabled={!dirty || saving}
                  onClick={() => setConfirm('reset')}
                >
                  Сбросить
                </Button>
                {draft.id && draft.id !== 'default' && (
                  <Button variant="ghost" disabled={saving} onClick={() => setConfirm('delete')}>
                    Удалить
                  </Button>
                )}
              </div>
            </div>
            {saveError && (
              <div role="alert" className="cqa-inline-notice cqa-form-error">
                {saveError}
              </div>
            )}
            <section className="cqa-data-panel cqa-checklist-settings">
              <div className="cqa-checklist-metadata">
                <label className="cqa-field">
                  Название
                  <input value={draft.name} onChange={(e) => update({ name: e.target.value })} />
                </label>
                <label className="cqa-field">
                  Округление
                  <input
                    type="number"
                    min={0}
                    max={6}
                    step={1}
                    value={draft.rounding ?? 2}
                    onChange={(e) => update({ rounding: Number(e.target.value) })}
                  />
                </label>
                <div className="cqa-weight-summary">
                  <span>Сумма весов</span>
                  <strong>
                    {number(sum)}
                    <small> / 100</small>
                  </strong>
                </div>
              </div>
              {sum !== 100 && (
                <p className="cqa-cell-muted">
                  Итог нормируется к 100 при любой сумме применимых весов.
                </p>
              )}
              <details className="cqa-checklist-options">
                <summary>Примечания, секции и история версий</summary>
                <label className="cqa-field">
                  Общие примечания для модели
                  <textarea
                    rows={2}
                    value={draft.notes || ''}
                    onChange={(e) => update({ notes: e.target.value })}
                  />
                </label>
                <SectionTitle title="Секции" />
                {draft.sections.map((section, index) => (
                  <div className="cqa-section-edit-row" key={index}>
                    <label className="cqa-field">
                      ID
                      <input
                        value={section.id}
                        onChange={(e) => {
                          const previous = section.id;
                          update({
                            sections: draft.sections.map((item, key) =>
                              key === index ? { ...item, id: e.target.value } : item,
                            ),
                            criteria: draft.criteria.map((criterion) =>
                              criterion.section === previous
                                ? { ...criterion, section: e.target.value }
                                : criterion,
                            ),
                          });
                        }}
                      />
                    </label>
                    <label className="cqa-field">
                      Название
                      <input
                        value={section.name}
                        onChange={(e) =>
                          update({
                            sections: draft.sections.map((item, key) =>
                              key === index ? { ...item, name: e.target.value } : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <button
                      className="cqa-icon-action"
                      aria-label={`Удалить секцию ${section.name}`}
                      onClick={() =>
                        update({
                          sections: draft.sections.filter((_, key) => key !== index),
                          criteria: draft.criteria.map((criterion) =>
                            criterion.section === section.id
                              ? { ...criterion, section: null }
                              : criterion,
                          ),
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    let index = draft.sections.length + 1;
                    while (draft.sections.some((section) => section.id === `s${index}`)) index++;
                    update({
                      sections: [...draft.sections, { id: `s${index}`, name: 'Новая секция' }],
                    });
                  }}
                >
                  Добавить секцию
                </Button>
                {draft.history?.length ? (
                  <div className="cqa-version-history">
                    <h3>Предыдущие версии</h3>
                    {draft.history
                      .slice()
                      .reverse()
                      .map((version) => (
                        <p key={version.version}>
                          v{version.version} ·{' '}
                          {new Date(version.updated_at).toLocaleDateString('ru-RU')} ·{' '}
                          {version.criteria.length} критериев
                        </p>
                      ))}
                  </div>
                ) : null}
              </details>
            </section>
            <section className="cqa-data-panel cqa-checklist-workbench">
              <aside className="cqa-criterion-list">
                <div className="cqa-inline-between">
                  <h2>Критерии</h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const criterion = newCriterion(draft.criteria, draft.sections[0]?.id);
                      update({ criteria: [...draft.criteria, criterion] });
                      setSelected(draft.criteria.length);
                    }}
                  >
                    + Добавить
                  </Button>
                </div>
                {draft.criteria.map((criterion, index) => (
                  <button
                    key={index}
                    className={`cqa-criterion-list-item ${selected === index ? 'is-active' : ''}`}
                    onClick={() => setSelected(index)}
                    aria-pressed={selected === index}
                  >
                    <span className="cqa-criterion-code">
                      {criterion.code || String(index + 1).padStart(2, '0')}
                    </span>
                    <span>
                      <strong>{criterion.title || 'Без названия'}</strong>
                      <small>{typeLabels[criterion.type]}</small>
                    </span>
                    <b>{criterion.type === 'flag' ? '⚑' : number(criterion.weight)}</b>
                  </button>
                ))}
              </aside>
              {selectedCriterion ? (
                <CriterionEditor
                  key={`${selected}:${draft.id}`}
                  criterion={selectedCriterion}
                  sections={draft.sections}
                  first={selected === 0}
                  last={selected === draft.criteria.length - 1}
                  onChange={criterionChange}
                  onRemove={() => {
                    update({ criteria: draft.criteria.filter((_, index) => index !== selected) });
                    setSelected(Math.max(0, selected - 1));
                  }}
                  onMove={(direction) => {
                    const criteria = draft.criteria.slice();
                    [criteria[selected], criteria[selected + direction]] = [
                      criteria[selected + direction],
                      criteria[selected],
                    ];
                    update({ criteria });
                    setSelected(selected + direction);
                  }}
                />
              ) : (
                <Empty title="Добавьте первый критерий">
                  <p>Опишите правило и выберите тип ответа.</p>
                </Empty>
              )}
            </section>
            <div className="cqa-method-note">
              Новая версия сохраняет историю оценок. После изменения правил диалогам потребуется
              новая оценка. Официальный JSON доступен только для чек-листа, совместимого с форматом
              организаторов.
            </div>
          </>
        )}
      </div>
      {confirm && (
        <Modal
          title={confirm === 'delete' ? 'Удалить чек-лист?' : 'Сбросить изменения?'}
          onClose={() => !saving && setConfirm(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirm(null)}>
                Отмена
              </Button>
              <Button
                variant={confirm === 'delete' ? 'danger' : 'primary'}
                loading={saving}
                onClick={() => {
                  if (confirm === 'delete') void remove();
                  else {
                    drafts.current.delete(`${draft?.id}:${draft?.version}`);
                    setDraft(resource.data ? clone(resource.data) : blankChecklist());
                    setCopying(false);
                    setConfirm(null);
                  }
                }}
              >
                {confirm === 'delete' ? 'Удалить' : 'Сбросить'}
              </Button>
            </>
          }
        >
          <p>
            {confirm === 'delete'
              ? 'Чек-лист будет удалён из выбора. Сохранённые оценки содержат снимок правил.'
              : 'Черновик будет заменён последней сохранённой версией.'}
          </p>
        </Modal>
      )}
      {pendingSwitch && (
        <Modal
          title="Переключить чек-лист?"
          onClose={() => setPendingSwitch(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setPendingSwitch(null)}>
                Продолжить редактирование
              </Button>
              <Button variant="primary" onClick={switchConfirmed}>
                Переключить
              </Button>
            </>
          }
        >
          <p>
            Несохранённые изменения этого чек-листа останутся в черновике до перезагрузки страницы.
          </p>
        </Modal>
      )}
    </div>
  );
}
