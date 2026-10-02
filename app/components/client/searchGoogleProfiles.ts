import { mapsUrlFromPlace, profileNameMatchesQuery, rankPublicProfiles } from '../../../lib/google-place-match.js';

export type GoogleProfileHit = {
  placeId: string;
  name: string;
  address: string;
  rating?: number;
  reviews?: number;
  type?: string;
  mapsUrl: string;
};

type MapsNamespace = {
  maps?: {
    importLibrary?: (name: string) => Promise<PlacesLibrary>;
    places?: {
      AutocompleteService?: new () => {
        getPlacePredictions: (
          request: Record<string, unknown>,
          callback: (predictions: Prediction[] | null, status: string) => void,
        ) => void;
      };
      PlacesServiceStatus?: { OK: string; ZERO_RESULTS: string };
    };
  };
};

type PlacesLibrary = {
  Place?: {
    searchByText: (request: Record<string, unknown>) => Promise<{ places?: TextPlace[] }>;
  };
};

type TextPlace = {
  id?: string;
  displayName?: string | { text?: string };
  formattedAddress?: string;
  googleMapsURI?: string;
  googleMapsUri?: string;
  rating?: number;
  userRatingCount?: number;
};

type Prediction = {
  place_id?: string;
  description?: string;
  structured_formatting?: { main_text?: string; secondary_text?: string };
};

declare global {
  interface Window {
    google?: MapsNamespace;
  }
}

let mapsReady: Promise<void> | null = null;
let textSearchDisabled = false;

function installMapsLoader(apiKey: string) {
  const existing = window.google?.maps?.importLibrary;
  if (existing) return Promise.resolve();
  if (mapsReady) return mapsReady;
  mapsReady = new Promise((resolve) => {
    const params = {
      key: apiKey,
      v: 'weekly',
      language: 'nb',
    };
    const googleName = 'google';
    const importName = 'importLibrary';
    const callbackName = '__ib__';
    const root = window as unknown as Record<string, Record<string, unknown>>;
    const googleNs = (root[googleName] || (root[googleName] = {})) as Record<string, unknown>;
    const maps = (googleNs.maps || (googleNs.maps = {})) as Record<string, unknown>;
    const requested = new Set<string>();
    const search = new URLSearchParams();
    let loading: Promise<void> | null = null;
    const start = () => loading || (loading = new Promise((done, fail) => {
      const script = document.createElement('script');
      search.set('libraries', [...requested].join(','));
      for (const [name, value] of Object.entries(params)) {
        search.set(name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`), value);
      }
      search.set('callback', `${googleName}.maps.${callbackName}`);
      script.src = `https://maps.googleapis.com/maps/api/js?${search.toString()}`;
      script.async = true;
      maps[callbackName] = () => done();
      script.onerror = () => fail(new Error('Google Places lastet ikke.'));
      document.head.appendChild(script);
    }));
    const stub = (library: string) => {
      requested.add(library);
      return start().then(() => {
        const next = maps[importName] as ((name: string) => Promise<PlacesLibrary>) | typeof stub;
        if (next === stub) throw new Error('Google Places lastet ikke.');
        return next(library);
      });
    };
    maps[importName] = stub;
    resolve();
  });
  return mapsReady.catch((error) => {
    mapsReady = null;
    throw error;
  });
}

function displayNameOf(place: TextPlace) {
  if (typeof place.displayName === 'string') return place.displayName.trim();
  return String(place.displayName?.text || '').trim();
}

function keepMatching(rows: GoogleProfileHit[], query: string) {
  return rankPublicProfiles(
    rows.filter((row) => row.placeId && row.name && profileNameMatchesQuery(row.name, query)),
    query,
  );
}

async function searchByText(query: string): Promise<GoogleProfileHit[]> {
  const imported = await window.google?.maps?.importLibrary?.('places');
  const Place = imported?.Place;
  if (!Place?.searchByText) throw new Error('Places text search er ikke tilgjengelig.');
  const { places = [] } = await Place.searchByText({
    textQuery: query,
    fields: ['id', 'displayName', 'formattedAddress', 'googleMapsURI', 'rating', 'userRatingCount'],
    language: 'nb',
    region: 'no',
    maxResultCount: 8,
  });
  return places.map((place) => {
    const name = displayNameOf(place);
    const placeId = String(place.id || '').trim();
    const address = String(place.formattedAddress || '').trim();
    const mapsUrl = String(place.googleMapsURI || place.googleMapsUri || '').trim()
      || mapsUrlFromPlace({ placeId, name, address });
    return {
      placeId,
      name,
      address,
      rating: Number(place.rating) || 0,
      reviews: Number(place.userRatingCount) || 0,
      mapsUrl,
    };
  }).filter((row) => row.name);
}

function searchNorwayPredictions(query: string): Promise<GoogleProfileHit[]> {
  const Service = window.google?.maps?.places?.AutocompleteService;
  if (!Service) return Promise.reject(new Error('Google-listen er ikke tilgjengelig.'));
  const service = new Service();
  return new Promise((resolve, reject) => {
    service.getPlacePredictions({
      input: query,
      componentRestrictions: { country: 'no' },
      types: ['establishment'],
    }, (predictions, status) => {
      const ok = !status || status === 'OK' || status === 'ZERO_RESULTS';
      if (!ok) {
        reject(new Error(status || 'Google-listen feilet.'));
        return;
      }
      resolve((predictions || []).map((prediction) => {
        const name = String(prediction.structured_formatting?.main_text || prediction.description || '').trim();
        const placeId = String(prediction.place_id || '').trim();
        const address = String(prediction.structured_formatting?.secondary_text || '').trim();
        return {
          placeId,
          name,
          address,
          mapsUrl: mapsUrlFromPlace({ placeId, name, address }),
        };
      }).filter((row) => row.name));
    });
  });
}

/**
 * Browser Places Text Search, biased to Norway, using the referrer-restricted Maps key.
 * Place ID plus displayName is the public profile. Owner-only Business Profile
 * location ids are a later connect step, not this picker.
 */
export async function searchGoogleProfilesInBrowser(apiKey: string, query: string): Promise<GoogleProfileHit[]> {
  const key = String(apiKey || '').trim();
  const q = String(query || '').trim();
  if (!key || q.length < 3) return [];
  await installMapsLoader(key);
  if (!textSearchDisabled) {
    try {
      const matched = keepMatching(await searchByText(q), q);
      if (matched.length) return matched;
    } catch {
      textSearchDisabled = true;
    }
  }
  try {
    return keepMatching(await searchNorwayPredictions(q), q);
  } catch (error) {
    if (!textSearchDisabled) return [];
    throw error;
  }
}
