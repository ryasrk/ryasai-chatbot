import { describe, expect, test } from 'bun:test'
import { needsClarificationByRule } from './intent-pipeline'

/**
 * The documented ambiguity rule has NEVER worked, and the reason was placement.
 *
 * The intent prompt has always listed two cases requiring clarification — a pronoun with no
 * antecedent, and a relative time with no frame. Beneath them sits a "CRITICAL — DEFAULT TO NOT
 * CLARIFYING" block, and a heuristic guard suppresses any clarification when data sources exist
 * and the question contains 'berapa' / 'how many'. So the model's own answers were overridden:
 *
 *     "Berapa banyak itu?"     -> needsClarification=false -> answered
 *     "Tampilkan data terbaru." -> needsClarification=false -> answered
 *
 * Measured against the real provider, all four of the prompt's OWN examples were answered instead
 * of clarified, and one produced a confident "Jumlahnya 2.405 (total stok)" — a number chosen from
 * one of three connected databases, which the user could not identify as a guess.
 *
 * These tests are DETERMINISTIC on purpose: the rule is code, not a prompt, because two prompt
 * rewrites (one of them explaining the failure inline) changed nothing. A model cannot be relied on
 * to gate itself, and this must hold on every request.
 */
describe('needsClarificationByRule', () => {
  test('a quantity question with NO subject requires clarification', () => {
    // The subject-less shape is the whole signal: there is nothing to auto-select a table against.
    for (const q of [
      'Berapa banyak itu?',
      'Berapa banyak dari itu?',
      'How many of those are there?',
      'How many of them?',
    ]) {
      expect({ q, needed: needsClarificationByRule(q).needed }).toEqual({ q, needed: true })
    }
  })

  test('a relative time with NO frame requires clarification', () => {
    for (const q of ['Tampilkan data terbaru.', 'Show me recent data.', 'Data terakhir dong.']) {
      expect({ q, needed: needsClarificationByRule(q).needed }).toEqual({ q, needed: true })
    }
  })

  test('naming the SUBJECT keeps it answerable — a false clarification is the worse error', () => {
    // Every one of these is a legitimate data question. Blocking one costs the user their answer,
    // so the rule must not fire merely because a vague word appears.
    for (const q of [
      'Berapa jumlah karyawan?',
      'Berapa banyak pelanggan yang terdaftar?',
      'Berapa jumlah pesanan bulan ini?',
      'Tampilkan 5 pelanggan teratas.',
      'Berapa total penjualan tahun 2024?',
      'Siapa saja nama karyawan di departemen HR?',
      'Tampilkan data pelanggan terbaru.',
      'Show me recent orders.',
      'Berapa banyak film yang dirilis tahun 2005?',
    ]) {
      expect({ q, needed: needsClarificationByRule(q).needed }).toEqual({ q, needed: false })
    }
  })

  test('a pronoun WITH an explicit noun in the same question does not fire', () => {
    // "berapa jumlah karyawan itu?" names karyawan. Only a subject-LESS question is unanswerable.
    expect(needsClarificationByRule('Berapa jumlah karyawan itu?').needed).toBe(false)
  })

  test('a relative time WITH a frame does not fire', () => {
    for (const q of ['Tampilkan pesanan terbaru minggu ini.', 'Show me the latest orders this month.']) {
      expect({ q, needed: needsClarificationByRule(q).needed }).toEqual({ q, needed: false })
    }
  })

  test('the KIND distinguishes the two clarifications — prose reasons must not be branched on', () => {
    // The caller used to compare the human-readable `reason` string, and when that text gained a
    // suffix ("and no subject") the comparison stopped matching, so "Tampilkan data terbaru." was
    // answered with the COUNT clarification. `kind` is the stable key; `reason` is documentation.
    expect(needsClarificationByRule('Berapa banyak itu?').kind).toBe('subject')
    expect(needsClarificationByRule('Tampilkan data terbaru.').kind).toBe('time')
    expect(needsClarificationByRule('Show me recent data.').kind).toBe('time')
    // And it must be absent when no clarification is needed, so a caller cannot act on a stale kind.
    expect(needsClarificationByRule('Berapa jumlah karyawan?').kind).toBeUndefined()
  })
})
