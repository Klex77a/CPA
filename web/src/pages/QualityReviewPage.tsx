import { useRef, useState, type ChangeEvent } from 'react';
import { Badge, Button, Modal, PageHeader } from '../components/ui';
import Icon from '../components/Icon';
import { speakerNames } from '../format';
import {
  emptyAnnotation,
  labelProblem,
  parsePacket,
  restoreAnnotation,
  type HumanAnnotation,
  type HumanLabel,
  type ReviewPacket,
} from './quality/review';
import '../styles/quality-review.css';

function saveFile(data: HumanAnnotation) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `human-review-${data.packet_id}-${data.stage}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function QualityReviewPage() {
  const [packet, setPacket] = useState<ReviewPacket | null>(null),
    [annotation, setAnnotation] = useState<HumanAnnotation | null>(null);
  const [pending, setPending] = useState<ReviewPacket | null>(null);
  const [caseIndex, setCaseIndex] = useState(0),
    [criterionIndex, setCriterionIndex] = useState(0);
  const [error, setError] = useState(''),
    [saved, setSaved] = useState(''),
    [busy, setBusy] = useState(false),
    [attested, setAttested] = useState(false);
  const packetInput = useRef<HTMLInputElement>(null),
    draftInput = useRef<HTMLInputElement>(null);
  const current = packet?.cases[caseIndex],
    criterion = packet?.checklist.criteria[criterionIndex];
  const label = criterion && annotation?.cases[caseIndex].criteria[criterion.id];
  const complete =
    packet && annotation
      ? annotation.cases.reduce(
          (sum, row, index) =>
            sum +
            packet.checklist.criteria.filter(
              (item) =>
                !labelProblem(row.criteria[item.id], item, packet.cases[index].transcript.length),
            ).length,
          0,
        )
      : 0;
  const total = packet ? packet.cases.length * packet.checklist.criteria.length : 0;
  const accept = (next: ReviewPacket) => {
    setPacket(next);
    setAnnotation(emptyAnnotation(next));
    setCaseIndex(0);
    setCriterionIndex(0);
    setAttested(false);
    setError('');
    setSaved('');
    setPending(null);
  };
  const loadPacket = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget,
      file = input.files?.[0];
    input.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Максимальный размер пакета — 20 МБ.');
      const next = await parsePacket(JSON.parse(await file.text()));
      if (packet) setPending(next);
      else accept(next);
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? 'Файл содержит некорректный JSON.'
          : cause instanceof Error
            ? cause.message
            : 'Не удалось прочитать пакет.',
      );
    } finally {
      setBusy(false);
    }
  };
  const loadDraft = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget,
      file = input.files?.[0];
    input.value = '';
    if (!file || !packet) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Максимальный размер черновика — 20 МБ.');
      setAnnotation(restoreAnnotation(packet, JSON.parse(await file.text())));
      setAttested(false);
      setError('');
      setSaved('Черновик восстановлен. Перед сдачей подтвердите условия ручной проверки.');
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? 'Некорректный JSON черновика.'
          : cause instanceof Error
            ? cause.message
            : 'Черновик недоступен.',
      );
    }
  };
  const updateLabel = (patch: Partial<HumanLabel>) => {
    if (!annotation || !criterion) return;
    setAnnotation({
      ...annotation,
      stage: 'draft',
      cases: annotation.cases.map((row, index) =>
        index === caseIndex
          ? {
              ...row,
              criteria: {
                ...row.criteria,
                [criterion.id]: { ...row.criteria[criterion.id], ...patch },
              },
            }
          : row,
      ),
    });
    setSaved('');
    setError('');
  };
  const choose = (value: string) => {
    if (value === '') updateLabel({ state: 'unanswered', value: null });
    else if (value === 'unknown') updateLabel({ state: 'unknown', value: null });
    else
      updateLabel({
        state: 'labeled',
        value:
          value === 'na' ? null : value === 'yes' ? true : value === 'no' ? false : Number(value),
      });
  };
  const download = (submitted: boolean) => {
    if (!packet || !annotation) return;
    if (submitted) {
      if (!annotation.reviewer.id.trim() || !annotation.reviewer.role.trim() || !attested) {
        setError('Укажите проверяющего, роль и подтвердите условия слепой ручной проверки.');
        return;
      }
      for (let ci = 0; ci < packet.cases.length; ci++)
        for (let ri = 0; ri < packet.checklist.criteria.length; ri++) {
          const item = packet.checklist.criteria[ri],
            problem = labelProblem(
              annotation.cases[ci].criteria[item.id],
              item,
              packet.cases[ci].transcript.length,
            );
          if (problem) {
            setCaseIndex(ci);
            setCriterionIndex(ri);
            setError(`Диалог ${ci + 1}, «${item.title}»: ${problem}`);
            return;
          }
        }
    }
    const result: HumanAnnotation = {
      ...annotation,
      stage: submitted ? 'submitted' : 'draft',
      reviewer: {
        ...annotation.reviewer,
        id: annotation.reviewer.id.trim(),
        role: annotation.reviewer.role.trim(),
        independence: 'self_attested',
        attestation: {
          human: submitted,
          model_answers_unseen: submitted,
          no_llm_assistance: submitted,
          submitted_at: submitted ? new Date().toISOString() : '',
        },
      },
    };
    saveFile(result);
    setSaved(
      submitted
        ? 'Разметка скачана. Передайте JSON координатору для сверки со вторым экспертом.'
        : 'Черновик скачан. Для продолжения снова откройте пакет и загрузите этот черновик.',
    );
    setError('');
  };
  const reviewer = (key: 'id' | 'role', value: string) => {
    if (annotation)
      setAnnotation({ ...annotation, reviewer: { ...annotation.reviewer, [key]: value } });
    setSaved('');
  };
  const selectedValue =
    label?.state === 'unknown'
      ? 'unknown'
      : label?.state !== 'labeled'
        ? ''
        : label.value === null
          ? 'na'
          : label.value === true
            ? 'yes'
            : label.value === false
              ? 'no'
              : String(label.value);
  return (
    <section className="cqa-page cqa-review-page">
      <PageHeader
        title="Проверка качества"
        subtitle="Слепая разметка человеком · ответы модели скрыты"
      >
        <Button
          icon={<Icon name="upload" />}
          onClick={() => packetInput.current?.click()}
          loading={busy}
        >
          {packet ? 'Другой пакет' : 'Открыть пакет'}
        </Button>
        {packet && (
          <>
            <Button onClick={() => draftInput.current?.click()}>Загрузить черновик</Button>
            <Button icon={<Icon name="download" />} onClick={() => download(false)}>
              Черновик
            </Button>
          </>
        )}
      </PageHeader>
      <input
        ref={packetInput}
        type="file"
        accept=".json,application/json"
        aria-label="Файл слепого пакета"
        hidden
        onChange={loadPacket}
      />
      <input
        ref={draftInput}
        type="file"
        accept=".json,application/json"
        aria-label="Файл черновика разметки"
        hidden
        onChange={loadDraft}
      />
      <div className="cqa-page-scroll cqa-review-scroll">
        {error && (
          <div className="cqa-note danger" role="alert">
            {error}
          </div>
        )}
        {saved && (
          <div className="cqa-note" role="status">
            {saved}
          </div>
        )}
        {!packet || !annotation || !current || !criterion || !label ? (
          <div className="cqa-review-intro">
            <Icon name="shield" size={34} />
            <h2>Сначала человеческая оценка, затем сравнение с ИИ</h2>
            <p>
              Эксперт видит исходные реплики и правила чек-листа. Результаты модели и исходные ID
              исключены из пакета. Ответ «Не могу проверить» сохраняется отдельно от N/A.
            </p>
            <ol>
              <li>
                Получите от координатора файл <code>packet.json</code>. Ответов модели в нём нет.
              </li>
              <li>
                Каждый из двух экспертов независимо открывает один и тот же <code>packet.json</code>
                , заполняет ответы и скачивает свою разметку.
              </li>
              <li>
                Координатор сверяет ответы, передаёт разногласия третьему эксперту и только затем
                сравнивает эталон с исходными ответами модели.
              </li>
            </ol>
            <a
              className="cqa-text-link"
              href="https://github.com/Klex77a/CPA/blob/main/docs/QUALITY_REVIEW.md"
              target="_blank"
              rel="noreferrer"
            >
              Инструкция для координатора и экспертов ↗
            </a>
            <div className="cqa-note warning">
              Подтверждение независимости — заявление эксперта. Программа не проверяет его личность.
              Разметка DEV не становится скрытым тестовым набором.
            </div>
            <Button
              variant="primary"
              onClick={() => packetInput.current?.click()}
              icon={<Icon name="upload" />}
            >
              Открыть packet.json
            </Button>
          </div>
        ) : (
          <>
            <div className="cqa-review-overview">
              <div>
                <Badge tone="info">Модель не показана</Badge>
                <strong>
                  {complete} из {total} критериев заполнено
                </strong>
                <span>
                  {packet.cases.length} диалогов · {packet.checklist.name}, версия{' '}
                  {packet.checklist.version}
                </span>
              </div>
              <progress value={complete} max={total} aria-label="Прогресс ручной разметки" />
            </div>
            <div className="cqa-note warning">
              Пакет может содержать персональные данные. Файл обрабатывается в этой вкладке и не
              отправляется на сервер. Сохраняйте черновик перед закрытием; не публикуйте пакет или
              разметку в Git.
            </div>
            <div className="cqa-review-selectors">
              <label className="cqa-field">
                Диалог
                <select
                  value={caseIndex}
                  onChange={(event) => {
                    setCaseIndex(Number(event.target.value));
                    setError('');
                  }}
                >
                  {packet.cases.map((item, index) => (
                    <option key={item.case_id} value={index}>
                      {index + 1}. {item.language} ·{' '}
                      {item.channel === 'voice call' ? 'Транскрипт звонка' : 'Чат'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cqa-field">
                Критерий
                <select
                  value={criterionIndex}
                  onChange={(event) => {
                    setCriterionIndex(Number(event.target.value));
                    setError('');
                  }}
                >
                  {packet.checklist.criteria.map((item, index) => (
                    <option key={item.id} value={index}>
                      {index + 1}. {item.title}
                      {labelProblem(
                        annotation.cases[caseIndex].criteria[item.id],
                        item,
                        current.transcript.length,
                      )
                        ? ''
                        : ' ✓'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="cqa-review-grid">
              <section className="cqa-review-transcript">
                <div className="cqa-review-pane-title">
                  <h2>Исходный разговор</h2>
                  <span>
                    {current.language} · {current.transcript.length} реплик
                  </span>
                </div>
                <p className="cqa-review-hint">
                  Отметьте реплики, подтверждающие ответ. Для пропущенного действия выберите
                  проверенный участок.
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    updateLabel({ evidence_turns: current.transcript.map((turn) => turn.turn) })
                  }
                >
                  Проверен весь диалог
                </Button>
                <div className="cqa-review-turns">
                  {current.transcript.map((turn) => (
                    <button
                      key={turn.turn}
                      className={`cqa-review-turn ${turn.speaker} ${label.evidence_turns.includes(turn.turn) ? 'selected' : ''}`}
                      aria-pressed={label.evidence_turns.includes(turn.turn)}
                      onClick={() =>
                        updateLabel({
                          evidence_turns: label.evidence_turns.includes(turn.turn)
                            ? label.evidence_turns.filter((value) => value !== turn.turn)
                            : [...label.evidence_turns, turn.turn].sort((a, b) => a - b),
                        })
                      }
                    >
                      <span>
                        <b>
                          №{turn.turn} · {speakerNames[turn.speaker]}
                        </b>
                        <time>{turn.timestamp}</time>
                      </span>
                      <p>{turn.text}</p>
                    </button>
                  ))}
                </div>
              </section>
              <section className="cqa-review-editor">
                <div className="cqa-review-pane-title">
                  <h2>{criterion.title}</h2>
                  <Badge>
                    {criterionIndex + 1}/{packet.checklist.criteria.length}
                  </Badge>
                </div>
                <p className="cqa-review-rule">{criterion.description}</p>
                {criterion.na_allowed && criterion.na_condition && (
                  <p className="cqa-note">N/A: {criterion.na_condition}</p>
                )}
                <label className="cqa-field">
                  Решение эксперта
                  <select value={selectedValue} onChange={(event) => choose(event.target.value)}>
                    <option value="">Выберите ответ</option>
                    {criterion.type === 'scale' ? (
                      criterion.scale?.map((step) => (
                        <option key={step.value} value={step.value}>
                          {step.value} · {step.description}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="yes">Да</option>
                        <option value="no">Нет</option>
                      </>
                    )}
                    {criterion.na_allowed && <option value="na">N/A — критерий неприменим</option>}
                    <option value="unknown">Не могу проверить</option>
                  </select>
                </label>
                <label className="cqa-field">
                  Обоснование
                  <textarea
                    rows={4}
                    value={label.rationale}
                    onChange={(event) => updateLabel({ rationale: event.target.value })}
                    placeholder="Свяжите вывод с правилом и конкретными репликами."
                  />
                </label>
                {label.state === 'unknown' && (
                  <label className="cqa-field">
                    Почему ответ нельзя проверить
                    <textarea
                      rows={3}
                      value={label.unknown_reason || ''}
                      onChange={(event) => updateLabel({ unknown_reason: event.target.value })}
                      placeholder="Например, нет утверждённого регламента для проверки названного срока."
                    />
                  </label>
                )}
                <p className="cqa-review-evidence">
                  Отмеченные реплики:{' '}
                  <strong>
                    {label.evidence_turns.length
                      ? label.evidence_turns.map((turn) => `№${turn}`).join(', ')
                      : 'пока нет'}
                  </strong>
                </p>
                {label.state !== 'unanswered' &&
                  !labelProblem(label, criterion, current.transcript.length) && (
                    <Badge tone="success">Критерий заполнен</Badge>
                  )}
                <div className="cqa-review-navigation">
                  <Button
                    disabled={caseIndex === 0 && criterionIndex === 0}
                    onClick={() => {
                      if (criterionIndex > 0) setCriterionIndex(criterionIndex - 1);
                      else {
                        setCaseIndex(caseIndex - 1);
                        setCriterionIndex(packet.checklist.criteria.length - 1);
                      }
                    }}
                  >
                    Назад
                  </Button>
                  <Button
                    disabled={
                      caseIndex === packet.cases.length - 1 &&
                      criterionIndex === packet.checklist.criteria.length - 1
                    }
                    variant="primary"
                    onClick={() => {
                      if (criterionIndex < packet.checklist.criteria.length - 1)
                        setCriterionIndex(criterionIndex + 1);
                      else {
                        setCaseIndex(caseIndex + 1);
                        setCriterionIndex(0);
                      }
                    }}
                  >
                    Следующий критерий <Icon name="arrowRight" size={16} />
                  </Button>
                </div>
              </section>
            </div>
            <section className="cqa-review-submit">
              <h2>Сохранение ручной разметки</h2>
              <div className="cqa-form-grid">
                <label className="cqa-field">
                  Имя или рабочий ID эксперта
                  <input
                    value={annotation.reviewer.id}
                    onChange={(event) => reviewer('id', event.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="cqa-field">
                  Роль / квалификация
                  <input
                    value={annotation.reviewer.role}
                    onChange={(event) => reviewer('role', event.target.value)}
                    placeholder="Например, специалист контроля качества"
                  />
                </label>
              </div>
              <label className="cqa-review-attestation">
                <input
                  type="checkbox"
                  checked={attested}
                  onChange={(event) => setAttested(event.target.checked)}
                />
                <span>
                  Я лично проверил ответы, не видел оценки модели и не использовал ИИ для разметки.
                  Сведения об авторстве и независимости являются моим заявлением.
                </span>
              </label>
              <div>
                <Button onClick={() => download(false)}>Скачать черновик</Button>
                <Button
                  variant="primary"
                  icon={<Icon name="download" />}
                  onClick={() => download(true)}
                >
                  Сдать разметку JSON
                </Button>
              </div>
              <p>
                Согласование двух разметок и разбор разногласий выполняются отдельно. Само
                скачивание файла не подтверждает точность модели.
              </p>
            </section>
          </>
        )}
      </div>
      {pending && (
        <Modal
          title="Открыть другой пакет?"
          onClose={() => setPending(null)}
          footer={
            <>
              <Button onClick={() => setPending(null)}>Продолжить текущий</Button>
              <Button variant="primary" onClick={() => accept(pending)}>
                Открыть новый
              </Button>
            </>
          }
        >
          <p>
            Текущие ответы в этой вкладке будут заменены. Перед сменой пакета скачайте черновик.
          </p>
        </Modal>
      )}
    </section>
  );
}
