import React, { useEffect, useState } from 'react';
import { fetchSeoRecord, type SeoRecordView } from '../developer/seoRecordApi';

type Props = {
  salesClientId: string;
  authHeaders: Record<string, string>;
};

const LABEL: Record<string, string> = { approved: 'godkjent', proposed: 'foreslått', blocked: 'blokkert' };

/**
 * Read-only list of a client's agreed keywords for the offer composer. Shows nothing when the
 * client has no agreed keywords; developers decide them on the developer page.
 */
export function AgreedKeywordsList({ salesClientId, authHeaders }: Props) {
  const [record, setRecord] = useState<SeoRecordView | null>(null);
  const headersKey = JSON.stringify(authHeaders);
  useEffect(() => {
    let live = true;
    if (!salesClientId) return undefined;
    fetchSeoRecord(salesClientId, authHeaders)
      .then((answer) => { if (live) setRecord(answer.record); })
      .catch(() => { if (live) setRecord(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesClientId, headersKey]);

  const rows = (record?.agreedKeywords || []).filter((row) => row.status !== 'blocked');
  if (!rows.length) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-[#161616] p-4 text-xs text-gray-300 space-y-2">
      <div className="font-medium text-white text-sm">Avtalte søkeord</div>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.phrase} className="flex items-center gap-2">
            <span className="text-gray-100">{row.phrase}</span>
            <span className="text-[10px] text-gray-500">{LABEL[row.status] || row.status}</span>
          </li>
        ))}
      </ul>
      {record?.contractText ? <p className="text-[11px] text-gray-500">I kontrakten: {record.contractText}</p> : null}
    </div>
  );
}
