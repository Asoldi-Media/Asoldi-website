import React from 'react';
import { Calendar, Loader2 } from 'lucide-react';

type Props = {
  embedUrl: string;
  loading: boolean;
  connected: boolean;
  googleEmail: string;
  ownerLabel: string;
  isOwnCalendar: boolean;
  message: string;
  error: string;
  shareWarning: string;
  onConnect: () => void;
};

export function SalesCalendarWeek({
  embedUrl,
  loading,
  connected,
  googleEmail,
  ownerLabel,
  isOwnCalendar,
  message,
  error,
  shareWarning,
  onConnect,
}: Props) {
  const title = isOwnCalendar ? 'Din kalender' : `Kalender for ${ownerLabel}`;

  return (
    <div className="rounded-xl border border-white/10 overflow-hidden bg-black/20">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 border-b border-white/10">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">{title}</p>
          <p className="text-[11px] text-gray-400 truncate">
            {googleEmail
              ? googleEmail
              : 'Google ukevisning. Møter og kalenderavtaler vises med navn; annet er opptatt. Meeting bookers ser fortsatt bare opptatt.'}
          </p>
        </div>
      </div>
      {error ? (
        <div className="px-3 py-3 text-sm text-red-300">{error}</div>
      ) : loading ? (
        <div className="px-3 py-10 flex items-center justify-center gap-2 text-sm text-gray-300">
          <Loader2 size={16} className="animate-spin" />
          Henter kalender…
        </div>
      ) : !connected ? (
        <div className="p-4 text-sm text-gray-300 space-y-3">
          <p>{message || 'Koble Google Calendar for å se ukekalenderen her.'}</p>
          {isOwnCalendar ? (
            <button
              type="button"
              onClick={onConnect}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm"
            >
              <Calendar size={14} />
              Koble Google Calendar
            </button>
          ) : null}
        </div>
      ) : !embedUrl ? (
        <div className="p-4 text-sm text-gray-300 space-y-3">
          <p>Kalenderen er koblet, men Google-e-post mangler. Koble på nytt.</p>
          {isOwnCalendar ? (
            <button
              type="button"
              onClick={onConnect}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm"
            >
              <Calendar size={14} />
              Koble Google Calendar på nytt
            </button>
          ) : null}
        </div>
      ) : (
        <div className="bg-white overflow-x-auto">
          {shareWarning ? (
            <p className="px-3 py-2 text-[11px] text-amber-800 bg-amber-50 border-b border-amber-100">
              {shareWarning}
            </p>
          ) : null}
          <iframe
            title={title}
            src={embedUrl}
            className="block bg-white"
            style={{ border: 0, width: '100%', minWidth: 960, height: 920 }}
            width="960"
            height="920"
            scrolling="no"
          />
        </div>
      )}
    </div>
  );
}
