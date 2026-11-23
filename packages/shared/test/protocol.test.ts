import { describe, expect, it } from 'vitest';
import { CLOSE_CODES, MAX_MESSAGE_BYTES, parseClientMessage } from '../src/index.ts';

const NB = 'a1000000-0000-4000-8000-000000000001';
const TOKEN = 'x'.repeat(40);

describe('parseClientMessage', () => {
  it('accepts well-formed messages', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'hello', v: 1, token: TOKEN, neighborhoodId: NB, join: { mode: 'auto' } }))).toEqual({
      t: 'hello',
      v: 1,
      token: TOKEN,
      neighborhoodId: NB,
      join: { mode: 'auto' },
    });
    expect(parseClientMessage('{"t":"input","seq":5,"steer":-0.5,"throttle":1,"brake":0}')).toEqual({
      t: 'input',
      seq: 5,
      steer: -0.5,
      throttle: 1,
      brake: 0,
    });
    expect(parseClientMessage(JSON.stringify({ t: 'hello', v: 1, token: TOKEN, neighborhoodId: NB, join: { mode: 'friend', friendId: NB.toUpperCase() } })))
      .toMatchObject({ join: { mode: 'friend', friendId: NB } });
    expect(parseClientMessage('{"t":"leave"}')).toEqual({ t: 'leave' });
  });

  it.each([
    ['not json', 'nope'],
    ['array', '[1,2]'],
    ['unknown type', '{"t":"teleport","x":5}'],
    ['infinite steer', '{"t":"input","seq":1,"steer":1e999,"throttle":0,"brake":0}'],
    ['steer out of range', '{"t":"input","seq":1,"steer":2,"throttle":0,"brake":0}'],
    ['negative throttle', '{"t":"input","seq":1,"steer":0,"throttle":-1,"brake":0}'],
    ['fractional seq', '{"t":"input","seq":1.5,"steer":0,"throttle":0,"brake":0}'],
    ['string number', '{"t":"input","seq":"1","steer":0,"throttle":0,"brake":0}'],
    ['bad neighborhood id', JSON.stringify({ t: 'hello', v: 1, token: TOKEN, neighborhoodId: 'x', join: { mode: 'auto' } })],
    ['bad join mode', JSON.stringify({ t: 'hello', v: 1, token: TOKEN, neighborhoodId: NB, join: { mode: 'god' } })],
    ['short token', JSON.stringify({ t: 'hello', v: 1, token: 'abc', neighborhoodId: NB, join: { mode: 'auto' } })],
    ['oversized frame', JSON.stringify({ t: 'ping', id: 1, pad: 'x'.repeat(MAX_MESSAGE_BYTES) })],
  ])('rejects %s', (_label, raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it('ignores client-supplied state fields such as position or balance', () => {
    const m = parseClientMessage('{"t":"input","seq":1,"steer":0,"throttle":1,"brake":0,"x":999,"balance":1e9}');
    expect(m).toEqual({ t: 'input', seq: 1, steer: 0, throttle: 1, brake: 0 });
  });

  it('uses distinct application close codes', () => {
    const codes = Object.values(CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(c).toBeGreaterThanOrEqual(4000);
  });
});
