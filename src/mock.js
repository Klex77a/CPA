'use strict';
/**
 * ДЕМО-РЕЖИМ без ключа ИИ: грубые эвристики по ключевым словам.
 * Нужен только чтобы проверить интерфейс. Для реальной оценки задайте ключ ИИ в .env.
 */
const has = (text, words) => words.some((w) => text.includes(w));
const GREET = ['здравствуйте', 'добрый', 'привет', 'сәлем', 'қайырлы', 'hello', 'hi ', 'good morning', 'good afternoon', 'good evening'];
const INTRO = ['меня зовут', 'менің атым', 'my name is', 'this is ', "i'm ", 'на связи', 'оператор'];
const BYE = ['до свидания', 'всего доброго', 'хорошего дня', 'сау болыңыз', 'көмектесе аламын ба', 'goodbye', 'have a nice', 'have a great', 'anything else', 'чем-то ещё', 'чем еще', 'ещё вопросы', 'еще вопросы'];
const SORRY = ['извините', 'понимаю', 'сожалеем', 'кешіріңіз', 'түсінемін', 'sorry', 'understand', 'apolog'];
const COMPLAINT = ['недоволен', 'ужас', 'не работает', 'проблема', 'жалоба', 'долго', 'наразы', 'жұмыс істемейді', 'not working', 'problem', 'complain', 'terrible'];
const PROTECTED = ['баланс', 'вывод', 'счет', 'счёт', 'пароль', 'перевод', 'шот', 'balance', 'withdraw', 'account', 'password', 'transfer'];
const IDENT = ['идентификац', 'верификац', 'кодовое слово', 'дата рождения', 'иин', 'жсн', 'verif', 'identity', 'date of birth'];
const GROSS = ['переведите мне', 'на мою карту', 'мой личный номер', 'лично мне', 'to my card', 'my personal'];
const WAIT = ['минуту', 'подождите', 'ожидайте', 'күте тұрыңыз', 'one moment', 'please wait'];

function evaluate(record) {
  const tr = record.transcript || [];
  const ops = tr.map((m, i) => ({ ...m, i })).filter((m) => m.speaker === 'operator');
  const cl = tr.map((m, i) => ({ ...m, i })).filter((m) => m.speaker === 'client');
  const sys = tr.map((m, i) => ({ ...m, i })).filter((m) => m.speaker === 'system');
  const low = (m) => String(m.text || '').toLowerCase();
  const first = ops[0];
  const last = ops[ops.length - 1];
  const allClient = cl.map(low).join(' ');
  const out = [];
  const ev = (m) => (m ? [{ msg: 'm' + m.i }] : []);
  const all = { from: 'm0', to: 'm' + Math.max(0, tr.length - 1) };

  const greet = first && has(low(first), GREET) && has(low(first), INTRO);
  out.push({ id: 'c01', answer: greet ? 'YES' : 'NO', explanation: greet ? 'Оператор поздоровался и представился в первом ответе.' : 'В первом ответе оператора нет приветствия и/или представления.', evidence: ev(first), missing_range: first ? null : all });

  const asked = ops.some((m) => String(m.text).includes('?'));
  out.push({ id: 'c02', answer: asked ? 'YES' : 'NA', explanation: asked ? 'Оператор задал уточняющий вопрос.' : 'Уточнений не требовалось (эвристика).', na_reason: asked ? null : 'Данных для ответа, по-видимому, хватало с начала.', evidence: asked ? ev(ops.find((m) => String(m.text).includes('?'))) : ev(cl[0]) });

  const needsId = has(allClient, PROTECTED);
  const idMsg = [...ops, ...sys].find((m) => has(low(m), IDENT));
  out.push({ id: 'c03', answer: !needsId ? 'NA' : idMsg ? 'YES' : 'NO', explanation: !needsId ? 'Запрос не касается защищённых данных.' : idMsg ? 'Есть упоминание проверки личности.' : 'Запрос касался защищённых данных, проверки личности не найдено.', na_reason: !needsId ? 'Запрос не требовал идентификации.' : null, evidence: idMsg ? ev(idMsg) : ev(cl[0]), missing_range: needsId && !idMsg ? all : null });

  const longest = ops.slice().sort((a, b) => String(b.text).length - String(a.text).length)[0];
  const v4 = !cl.length ? null : !longest ? 0 : String(longest.text).length > 120 ? 15 : String(longest.text).length > 50 ? 10 : 5;
  out.push({ id: 'c04', answer: v4 == null ? 'NA' : 'SCORE', score: v4, explanation: 'Демо-оценка по длине содержательного ответа оператора.', na_reason: v4 == null ? 'Клиент не сформулировал запрос.' : null, evidence: v4 == null ? [] : ev(longest), checked_range: v4 == null ? all : null });

  const complained = has(allClient, COMPLAINT);
  const emp = ops.some((m) => has(low(m), SORRY));
  out.push({ id: 'c05', answer: !complained || emp ? 'YES' : 'NO', explanation: complained ? (emp ? 'Оператор отреагировал на недовольство клиента.' : 'Клиент выразил недовольство, оператор не отреагировал.') : 'Оператор вежлив, жалоб не было.', evidence: ev(ops.find((m) => has(low(m), SORRY)) || first) });

  const warned = ops.some((m) => has(low(m), WAIT));
  out.push({ id: 'c06', answer: 'SCORE', score: warned || ops.length < 4 ? 10 : 7, explanation: 'Демо-оценка: ответы последовательные' + (warned ? ', ожидание озвучено.' : '.'), evidence: ev(ops.find((m) => has(low(m), WAIT)) || first) });

  const bye = last && has(low(last), BYE);
  const cut = tr.length && tr[tr.length - 1].speaker === 'client' && !bye;
  out.push({ id: 'c07', answer: bye ? 'YES' : cut ? 'NA' : 'NO', explanation: bye ? 'Оператор попрощался/предложил помощь.' : cut ? 'Чат оборвался на реплике клиента.' : 'Оператор не попрощался.', na_reason: cut ? 'Чат оборвался до возможности завершить.' : null, evidence: ev(last) , missing_range: !bye && !cut && last ? { from: 'm' + last.i, to: 'm' + (tr.length - 1) } : null, checked_range: cut ? all : null });

  const g = ops.find((m) => has(low(m), GROSS));
  out.push({ id: 'c08', answer: g ? 'YES' : 'NO', explanation: g ? 'Найдено предложение услуги в обход компании.' : 'Грубых нарушений в диалоге не выявлено.', evidence: ev(g), checked_range: g ? null : all });

  const nm = ops.map((m) => String(m.text).match(/(?:меня зовут|менің атым|my name is|this is)\s+([A-ZА-ЯЁӘҒҚҢӨҰҮҺІa-zа-яёәғқңөұүһі]+)/i)).find(Boolean);
  const coaching = out.filter((x) => x.answer === 'NO' && x.id !== 'c08').map((x) => ({ criterion_id: x.id, type: 'required', text: `Демо-совет по критерию ${x.id}.` })).slice(0, 3);
  return { operator_name: nm ? nm[1] : null, coaching, criteria: out, summary: 'ДЕМО-режим без ИИ: оценка по ключевым словам. Задайте ключ ИИ в .env для настоящей оценки.' };
}

module.exports = { evaluate };
