import React, { useEffect, useRef, useState } from 'react';

function mapsUrlFromPlace({ placeId = '', name = '', address = '' } = {}) {
  const id = String(placeId || '').trim();
  const query = String(name || '').trim() || String(address || '').trim();
  if (id) {
    const params = new URLSearchParams({ api: '1', query_place_id: id });
    if (query) params.set('query', query);
    return `https://www.google.com/maps/search/?${params.toString()}`;
  }
  if (!query) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export type GooglePlacePick = {
  placeId: string;
  name: string;
  address: string;
  mapsUrl: string;
};

type Props = {
  apiKey: string;
  defaultQuery?: string;
  selectedName?: string;
  onSelect: (place: GooglePlacePick) => void;
  onClear?: () => void;
  onLoadError?: () => void;
};

const SCRIPT_ID = 'google-maps-places-sdk';

declare global {
  interface Window {
    google?: {
      maps?: {
        places?: {
          Autocomplete: new (
            input: HTMLInputElement,
            opts?: Record<string, unknown>
          ) => {
            addListener: (event: string, handler: () => void) => unknown;
            getPlace: () => {
              place_id?: string;
              name?: string;
              formatted_address?: string;
              url?: string;
            };
          };
        };
        event?: { clearInstanceListeners?: (instance: unknown) => void };
      };
    };
  }
}

function loadPlacesLibrary(apiKey: string) {
  if (window.google?.maps?.places) return Promise.resolve();
  const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
  if (existing) {
    return new Promise<void>((resolve, reject) => {
      if (window.google?.maps?.places) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Google Places lastet ikke.')), { once: true });
    });
  }
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&language=nb`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google Places lastet ikke.'));
    document.head.appendChild(script);
  });
}

export function GooglePlaceAutocomplete({
  apiKey,
  defaultQuery = '',
  selectedName = '',
  onSelect,
  onClear,
  onLoadError,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [ready, setReady] = useState(Boolean(window.google?.maps?.places));
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    loadPlacesLibrary(apiKey)
      .then(() => {
        if (active) setReady(true);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Google Places lastet ikke.');
        onLoadError?.();
      });
    return () => {
      active = false;
    };
  }, [apiKey]);

  useEffect(() => {
    const input = inputRef.current;
    const Autocomplete = window.google?.maps?.places?.Autocomplete;
    if (!ready || !input || !Autocomplete) return undefined;

    const autocomplete = new Autocomplete(input, {
      types: ['establishment'],
      fields: ['place_id', 'name', 'formatted_address', 'url'],
    });
    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      const placeId = String(place?.place_id || '').trim();
      const name = String(place?.name || '').trim();
      if (!placeId || !name) return;
      const address = String(place?.formatted_address || '').trim();
      onSelectRef.current({
        placeId,
        name,
        address,
        mapsUrl: String(place?.url || '').trim() || mapsUrlFromPlace({ placeId, name, address }),
      });
    });

    return () => {
      window.google?.maps?.event?.clearInstanceListeners?.(autocomplete);
    };
  }, [ready]);

  return (
    <div>
      <style>{`.pac-container{z-index:10000;}`}</style>
      <input
        ref={inputRef}
        type="text"
        defaultValue={selectedName || defaultQuery}
        placeholder="Skriv bedriftsnavn og velg i listen"
        className="mt-2 w-full rounded-xl border border-[#DDE2EA] bg-white px-4 py-3 outline-none focus:border-[#FF5B00]"
        autoComplete="off"
      />
      {selectedName ? (
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-xs text-[#059669]">Valgt Google-profil: {selectedName}</p>
          {onClear ? (
            <button type="button" onClick={onClear} className="text-xs text-[#6B7280] underline">
              Fjern
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-xs text-[#6B7280]">
          Velg fra Google-listen. Vi lagrer Place ID og kan lage Maps-lenken automatisk.
        </p>
      )}
      {error ? <p className="mt-2 text-xs text-red-500">{error}</p> : null}
    </div>
  );
}
