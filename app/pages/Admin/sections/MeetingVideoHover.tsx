import React, { useEffect, useRef, useState } from 'react';
import { firefliesMediaUrl } from '../../sales/emailApi';
import { ClientMeetingCard } from './MeetingDataPanel';

type Props = {
  meetingId?: string;
  hasVideo?: boolean;
  children: React.ReactNode;
  className?: string;
};

const VIDEO_MISSING = 'Videoen er ikke på disk ennå.';

export function MeetingVideoHover({
  meetingId = '',
  hasVideo = false,
  children,
  className = '',
}: Props) {
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);
  const leaveTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    };
  }, []);

  function onEnter() {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    setHovered(true);
  }

  function onLeave() {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setHovered(false), 80);
  }

  function onClick(event: React.MouseEvent) {
    if ((event.target as HTMLElement).closest('button, a, select, input, textarea, label')) return;
    event.preventDefault();
    event.stopPropagation();
    if (!meetingId) return;
    setHovered(false);
    setOpen(true);
  }

  return (
    <>
      <div
        className={`relative ${className}`}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onClick={onClick}
      >
        {children}
        {hovered ? (
          <div
            className="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-white/15 bg-[#161616] p-2 shadow-xl"
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            onClick={(event) => event.stopPropagation()}
          >
            {meetingId && hasVideo ? (
              <video
                autoPlay
                muted
                playsInline
                controls
                preload="metadata"
                src={firefliesMediaUrl(meetingId, 'video')}
                className="w-full rounded-md bg-black max-h-[180px]"
              />
            ) : (
              <p className="text-[11px] text-gray-300">{VIDEO_MISSING}</p>
            )}
          </div>
        ) : null}
      </div>
      {open && meetingId ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/70 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-full max-w-3xl mt-8"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="px-2 py-1 rounded-md bg-white/10 text-white text-xs hover:bg-white/15"
              >
                Lukk
              </button>
            </div>
            <ClientMeetingCard meetingId={meetingId} />
          </div>
        </div>
      ) : null}
    </>
  );
}
