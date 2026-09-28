import React from 'react';
import { Link } from 'react-router-dom';
import {
  LegalLayout,
  LegalSection,
  LegalSubheading,
  LegalList,
  LegalCallout,
} from '../../components/legal/LegalLayout';

export const Personvern = () => {
  return (
    <LegalLayout
      title="Personvernerklæring"
      description="Hvordan Asoldi Markedsføring samler inn, bruker, lagrer og deler personopplysninger – inkludert data vi får tilgang til når du logger inn med Google eller andre tredjepartstjenester."
      path="/personvern"
    >
      <LegalSection id="innledning" title="1. Innledning">
        <p>
          Denne personvernerklæringen forklarer hvordan Asoldi Markedsføring (drevet under foretaket CHAPANA,
          org.nr. 934 327 497) («Asoldi», «vi», «oss») behandler personopplysninger når du besøker asoldi.com,
          bruker kundeportalen vår, kontakter oss eller inngår en avtale om våre tjenester.
        </p>
        <p>
          Vi behandler personopplysninger i samsvar med personvernforordningen (GDPR) og norsk personvernlovgivning.
          Ved å bruke nettstedet og tjenestene våre samtykker du til behandlingen som er beskrevet her. Når vi
          behandler personopplysninger på vegne av en kunde (kundens egne sluttbrukere), gjelder i tillegg{' '}
          <Link to="/databehandleravtale" className="text-[#FF5B00] hover:underline">
            databehandleravtalen
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="hvilke-data" title="2. Hvilke opplysninger vi samler inn">
        <p>Vi samler inn opplysninger du selv gir oss, og opplysninger som genereres automatisk når du bruker nettstedet:</p>
        <LegalSubheading>Opplysninger du gir oss</LegalSubheading>
        <LegalList
          items={[
            'Kontaktinformasjon: navn, e-postadresse, telefonnummer og bedriftsnavn (f.eks. via kontaktskjema, booking eller registrering).',
            'Kontoopplysninger: e-post og passord (passord lagres alltid kryptert/hashet) når du oppretter en konto i kundeportalen.',
            'Onboarding- og prosjektopplysninger: bransje, rolle, ønsker for nettsiden og annet materiale du laster opp (logo, bilder, tekst).',
            'Kommunikasjon: meldinger og forespørsler du sender oss.',
          ]}
        />
        <LegalSubheading>Opplysninger vi samler inn automatisk</LegalSubheading>
        <LegalList
          items={[
            'Tekniske data som IP-adresse, nettlesertype, enhet og operativsystem.',
            'Bruksdata om hvordan du navigerer på nettstedet, samlet via informasjonskapsler og lignende teknologi.',
          ]}
        />
        <p>
          Les mer om hvilke informasjonskapsler vi bruker i vår{' '}
          <Link to="/informasjonskapsler" className="text-[#FF5B00] hover:underline">
            erklæring om informasjonskapsler
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="google-data" title="3. Innlogging med Google og bruk av Google-data">
        <p>
          Når du velger å logge inn eller registrere deg med «Logg inn med Google», bruker vi Googles OAuth 2.0 for
          autentisering. Vi ber kun om tilgang til den minimale informasjonen vi trenger for å opprette og
          identifisere kontoen din:
        </p>
        <LegalList
          items={[
            'Navn fra Google-profilen din.',
            'E-postadressen knyttet til Google-kontoen din.',
            'Profilbilde og din offentlige Google-konto-ID (brukernavn).',
          ]}
        />
        <p>
          Vi ber <span className="text-white/80">ikke</span> om tilgang til e-postinnholdet ditt, kontaktene dine
          eller andre data i Google-kontoen din for å logge deg inn. Google-dataene brukes utelukkende til å:
        </p>
        <LegalList
          items={[
            'opprette og autentisere brukerkontoen din i kundeportalen,',
            'forhåndsutfylle profilen din med navn og e-post, og',
            'kommunisere med deg om kontoen og tjenestene dine.',
          ]}
        />

        <LegalSubheading>Google Kalender (avtalebooking)</LegalSubheading>
        <p>
          For å planlegge og administrere møter kan Asoldi koble til en egen Google-konto med tilgang til Google
          Kalender (omfanget <code className="text-white/80">https://www.googleapis.com/auth/calendar</code>). Dette
          brukes til å opprette, oppdatere og slette møteoppføringer og eventuelle Google Meet-lenker for avtaler du
          booker med oss. Vi bruker ikke denne tilgangen til å lese eller behandle din private kalender.
        </p>

        <LegalCallout title="Google API Services – begrenset bruk («Limited Use»)">
          <p>
            Asoldis bruk og overføring av informasjon mottatt fra Google API-er følger{' '}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noreferrer"
              className="text-[#FF5B00] hover:underline"
            >
              Google API Services User Data Policy
            </a>
            , inkludert kravene til begrenset bruk (Limited Use). Konkret betyr dette at vi:
          </p>
          <LegalList
            items={[
              'kun bruker Google-brukerdata til å levere og forbedre funksjonene du eksplisitt har bedt om,',
              'ikke overfører eller selger data til tredjeparter, med unntak for å levere tjenesten, av sikkerhetshensyn eller for å oppfylle gjeldende lovkrav,',
              'ikke bruker dataene til annonsering, og',
              'ikke lar mennesker lese dataene med mindre du har gitt samtykke, det er nødvendig av sikkerhets-/feilsøkingshensyn, eller loven krever det.',
            ]}
          />
        </LegalCallout>
      </LegalSection>

      <LegalSection id="andre-tredjeparter" title="4. Andre tredjeparts innloggingstjenester">
        <p>
          Vi tilbyr også innlogging via andre leverandører (f.eks. Facebook). Disse tjenestene gir oss kun
          grunnleggende profilinformasjon (typisk navn og e-postadresse) som du har godkjent å dele, og som brukes på
          samme måte som beskrevet for Google ovenfor. Behandlingen hos den enkelte leverandøren reguleres i tillegg av
          deres egne personvernvilkår.
        </p>
      </LegalSection>

      <LegalSection id="formal" title="5. Formål og rettslig grunnlag">
        <p>Vi behandler personopplysninger for følgende formål og på følgende rettslige grunnlag (GDPR art. 6):</p>
        <LegalList
          items={[
            'Levere og administrere tjenestene, kundeportalen og kontoen din – nødvendig for å oppfylle avtalen (art. 6 nr. 1 b).',
            'Svare på henvendelser og gi support – berettiget interesse / avtale (art. 6 nr. 1 b og f).',
            'Sende fakturaer og håndtere betaling – avtale og rettslig forpliktelse (art. 6 nr. 1 b og c).',
            'Forbedre og sikre nettstedet, samt analyse – berettiget interesse (art. 6 nr. 1 f).',
            'Markedsføring og nyhetsbrev – samtykke (art. 6 nr. 1 a), som du kan trekke tilbake når som helst.',
          ]}
        />
      </LegalSection>

      <LegalSection id="deling" title="6. Deling av opplysninger og databehandlere">
        <p>
          Vi selger aldri personopplysningene dine. Vi deler opplysninger kun med leverandører som behandler data på
          våre vegne (databehandlere) for å levere tjenesten, herunder:
        </p>
        <LegalList
          items={[
            'Hostinger (hosting og lagring av asoldi.com, kundens nettside og CMS-data i EØS).',
            'GitHub (privat kodelager for kundens nettsidefiler).',
            'Google (autentisering, kalender og kart) og andre innloggingsleverandører.',
            'E-postleverandør for transaksjons- og support-e-post.',
            'Stripe for å behandle betalinger av Asoldi-abonnement.',
            'Analyse- og kommunikasjonsverktøy som er innebygd på nettstedet.',
          ]}
        />
        <p>
          Databehandlere er bundet av databehandleravtaler og kan kun behandle opplysninger etter våre instrukser.
          Opplysninger kan overføres utenfor EU/EØS dersom leverandøren er lokalisert der; i så fall sikres
          overføringen med EUs standardkontraktsvilkår eller annet gyldig overføringsgrunnlag. Se også{' '}
          <Link to="/databehandleravtale" className="text-[#FF5B00] hover:underline">
            databehandleravtalen
          </Link>{' '}
          for underleverandører når vi behandler data på en kundes vegne.
        </p>
      </LegalSection>

      <LegalSection id="lagring" title="7. Lagringstid">
        <p>
          Vi oppbevarer personopplysninger så lenge det er nødvendig for formålene de ble samlet inn for, eller så
          lenge vi er pålagt etter lov (f.eks. bokføringsloven for fakturadata). Kontodata slettes eller anonymiseres
          innen rimelig tid etter at kundeforholdet avsluttes, med mindre annet følger av lov. Personopplysninger
          vi behandler på kundens vegne slettes etter databehandleravtalen (normalt innen 30 dager etter eksport
          ved opphør).
        </p>
      </LegalSection>

      <LegalSection id="rettigheter" title="8. Dine rettigheter">
        <p>Etter personvernregelverket har du rett til å:</p>
        <LegalList
          items={[
            'få innsyn i hvilke opplysninger vi behandler om deg,',
            'kreve retting av uriktige opplysninger,',
            'kreve sletting («retten til å bli glemt») der vilkårene er oppfylt,',
            'kreve begrensning av eller protestere mot behandlingen,',
            'be om dataportabilitet, og',
            'trekke tilbake samtykke når behandlingen bygger på samtykke.',
          ]}
        />
        <p>
          For å bruke rettighetene dine, kontakt oss på{' '}
          <a href="mailto:kontakt@asoldi.com" className="text-[#FF5B00] hover:underline">
            kontakt@asoldi.com
          </a>
          . Du kan også klage til Datatilsynet (datatilsynet.no) dersom du mener behandlingen er i strid med regelverket.
        </p>
        <p>
          Du kan når som helst koble fra Google-tilgangen via{' '}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noreferrer"
            className="text-[#FF5B00] hover:underline"
          >
            Google-kontoens app-tillatelser
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection id="sikkerhet" title="9. Sikkerhet">
        <p>
          Vi iverksetter egnede tekniske og organisatoriske tiltak for å beskytte personopplysninger mot uautorisert
          tilgang, tap eller misbruk. Passord lagres kryptert, og tilgang til data er begrenset til personell som
          trenger det for å levere tjenesten.
        </p>
      </LegalSection>

      <LegalSection id="roller" title="10. Roller når vi bygger nettsider for kunder">
        <p>
          Når vi utvikler og drifter en nettside for en kunde, er kunden behandlingsansvarlig for personopplysninger
          som samles inn via nettsiden (f.eks. via skjemaer, nettbutikk eller e-postlister), mens Asoldi opptrer som
          databehandler. Asoldi kan få tilgang til slike data for vedlikehold, sikkerhet og for å sikre korrekt
          funksjonalitet. Kunden er ansvarlig for sin egen GDPR-etterlevelse overfor sine sluttbrukere. Rollene,
          lagringssted, underleverandører, sikkerhet og sletting er beskrevet i{' '}
          <Link to="/databehandleravtale" className="text-[#FF5B00] hover:underline">
            databehandleravtalen
          </Link>
          . Se også våre{' '}
          <Link to="/vilkar" className="text-[#FF5B00] hover:underline">
            vilkår for bruk
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection id="endringer" title="11. Endringer i personvernerklæringen">
        <p>
          Vi kan oppdatere denne erklæringen ved behov. Vesentlige endringer varsles på nettstedet, og «sist
          oppdatert»-datoen øverst gjenspeiler siste versjon.
        </p>
      </LegalSection>
    </LegalLayout>
  );
};
