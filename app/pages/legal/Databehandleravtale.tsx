import React from 'react';
import { Link } from 'react-router-dom';
import {
  LegalLayout,
  LegalSection,
  LegalSubheading,
  LegalList,
  LegalCallout,
} from '../../components/legal/LegalLayout';

const legalLinkClass = 'text-[#FF5B00] hover:underline';

export const Databehandleravtale = () => {
  return (
    <LegalLayout
      title="Databehandleravtale"
      description="Avtale etter personvernforordningen artikkel 28 mellom kunden som behandlingsansvarlig og Asoldi som databehandler. Den gjelder personopplysninger vi behandler på kundens vegne når vi hoster og drifter nettsiden."
      path="/databehandleravtale"
    >
      <LegalSection id="formal" title="1. Avtalens formål">
        <p>
          Denne databehandleravtalen («avtalen») regulerer Asoldi Markedsførings (CHAPANA, org.nr. 934 327 497)
          («databehandler», «Asoldi») behandling av personopplysninger på vegne av kunden («behandlingsansvarlig»)
          i forbindelse med utvikling, hosting, vedlikehold og drift av kundens nettside og tilhørende CMS.
        </p>
        <p>
          Avtalen gjelder når kunden inngår en tjenesteavtale med oss, godtar vilkårene på asoldi.com, eller på
          annen måte lar oss behandle slike opplysninger. Den gjelder i tillegg til{' '}
          <Link to="/vilkar" className={legalLinkClass}>
            vilkår for bruk
          </Link>{' '}
          og{' '}
          <Link to="/personvern" className={legalLinkClass}>
            personvernerklæringen
          </Link>
          . Personvernerklæringen gjelder Asoldis behandling av opplysninger om kunden som vår forretningskunde.
          Denne avtalen gjelder behandling av opplysninger om kundens egne sluttbrukere og andre registrerte på
          kundens nettside.
        </p>
      </LegalSection>

      <LegalSection id="roller" title="2. Parter og roller">
        <LegalList
          items={[
            'Kunden er behandlingsansvarlig for personopplysninger som samles inn via kundens nettside, skjemaer, nettbutikk, e-postlister, bloggkommentarer og tilsvarende funksjoner.',
            'Asoldi er databehandler og behandler slike opplysninger bare etter kundens dokumenterte instruks, denne avtalen og gjeldende rett.',
            'Kunden er selv ansvarlig for å ha et lovlig behandlingsgrunnlag, å informere de registrerte, og å svare på henvendelser fra egne sluttkunder.',
          ]}
        />
      </LegalSection>

      <LegalSection id="behandling" title="3. Behandlingens art, formål og varighet">
        <p>Asoldi behandler personopplysninger for å:</p>
        <LegalList
          items={[
            'hoste og vise nettsiden,',
            'drifte skjemaer, CMS, analyse-dashbord, blogg og eventuell nettbutikk,',
            'utføre vedlikehold, sikkerhet, feilretting og sikkerhetskopiering,',
            'levere avtalt SEO, innhold og support så lenge abonnementet løper.',
          ]}
        />
        <p>
          Behandlingen varer så lenge tjenesteavtalen løper, og deretter i den tiden som trengs for eksport,
          sletting eller lovpålagt oppbevaring, se punkt 10.
        </p>
      </LegalSection>

      <LegalSection id="kategorier" title="4. Kategorier av registrerte og opplysninger">
        <LegalSubheading>Registrerte</LegalSubheading>
        <LegalList
          items={[
            'Besøkende på kundens nettside.',
            'Personer som sender inn skjemaer eller melder seg på e-postlister.',
            'Kunder og brukere i nettbutikk, dersom det inngår i abonnementet.',
            'Ansatte eller kontaktpersoner hos kunden som får tilgang til CMS.',
          ]}
        />
        <LegalSubheading>Typer personopplysninger</LegalSubheading>
        <LegalList
          items={[
            'Identitets- og kontaktopplysninger (navn, e-post, telefon, adresse) som den registrerte eller kunden legger inn.',
            'Meldingsinnhold fra skjemaer.',
            'Bestillings-, produkt- og betalingsrelaterte opplysninger i nettbutikk (selve kortbetalingen håndteres av betalingsleverandøren).',
            'Tekniske logger som er nødvendige for drift og sikkerhet (for eksempel IP-adresse og tidspunkt).',
            'Bruks- og resultatmål i analyse-dashbordet og i de periodiske rapportene (trafikk, rangering, avvisningsrate, konvertering og lignende), når slike rapporter inngår i kundens nivå.',
          ]}
        />
        <p>
          Asoldi skal ikke behandle særlige kategorier av personopplysninger (helse, religion, biometri og
          lignende) på kundens vegne med mindre kunden uttrykkelig ber om det skriftlig og partene blir enige om
          tilleggsvilkår.
        </p>
      </LegalSection>

      <LegalSection id="instruks" title="5. Instruks">
        <p>
          Kunden instruerer Asoldi om å behandle opplysningene bare for å levere den avtalte tjenesten. Asoldi
          følger dokumenterte instrukser fra kunden, med mindre norsk eller EØS-rett krever noe annet. Dersom en
          instruks etter Asoldis vurdering er i strid med personvernregelverket, sier vi fra til kunden.
        </p>
      </LegalSection>

      <LegalSection id="lagring" title="6. Hvor data lagres">
        <LegalList
          items={[
            'Kundens publiserte nettside (HTML, bilder og tilhørende filer) driftes på Hostinger i EØS, med kildekode og eiendeler i et privat kodelager hos GitHub.',
            'CMS-data for den enkelte kundens nettsted – inkludert skjemaer, produkter, brukere og opplastinger – lagres på Hostinger-disk knyttet til det aktuelle nettstedet, utenfor det offentlige kodelageret.',
            'Asoldis egen hub (asoldi.com, kundeportal, tilbud og fakturagrunnlag) lagres på Hostinger i EØS.',
            'Analyse- og rangeringsdata som vises i kunde-CMS, lagres sammen med øvrige CMS-data for det nettstedet.',
          ]}
        />
        <p>
          Asoldi flytter ikke behandlingen til et annet land utenfor EØS uten et gyldig overføringsgrunnlag, se
          punkt 12.
        </p>
      </LegalSection>

      <LegalSection id="underleverandorer" title="7. Underleverandører">
        <p>
          Kunden gir Asoldi et generelt samtykke til å bruke underleverandører som er nødvendige for å levere
          tjenesten. Asoldi inngår databehandleravtaler med underleverandørene og pålegger dem tilsvarende
          plikter. Vesentlige endringer i listen varsles, og kunden kan protestere av saklig personvernmessig
          grunn.
        </p>
        <p>Typiske underleverandører er:</p>
        <LegalList
          items={[
            'Hostinger – hosting, e-postinfrastruktur og lagring av nettside og CMS-data.',
            'GitHub – privat lagring av nettsidens kildekode og eiendeler.',
            'Stripe – betalinger for Asoldis abonnement. Eventuell kortbetaling i kundens nettbutikk går til den betalingsleverandøren kunden selv kobler på.',
            'Google – innlogging, kalender og kart der det er slått på.',
            'E-postleverandør (for eksempel Resend) for transaksjons- og support-e-post.',
          ]}
        />
      </LegalSection>

      <LegalSection id="sikkerhet" title="8. Sikkerhet">
        <p>
          Asoldi iverksetter egnede tekniske og organisatoriske tiltak ut fra risikoen, blant annet:
        </p>
        <LegalList
          items={[
            'tilgangsstyring og minst mulig tilgang for personell som trenger det for å levere tjenesten,',
            'kryptert innlogging og hashede passord i våre systemer,',
            'HTTPS for overføring,',
            'sikkerhetskopier og tiltak mot tap og uautorisert endring,',
            'rutiner for feilretting og sikkerhetshendelser.',
          ]}
        />
        <p>
          Kunden skal holde egne CMS-innlogginger hemmelige og varsle Asoldi ved mistanke om misbruk.
        </p>
      </LegalSection>

      <LegalSection id="bistand" title="9. Bistand, brudd og de registrertes rettigheter">
        <LegalList
          items={[
            'Asoldi bistår kunden, så langt det er rimelig gitt tjenestens art, med å svare på krav fra registrerte (innsyn, retting, sletting, begrensning, portabilitet og protest).',
            'Asoldi varsler kunden uten ugrunnet opphold etter å ha blitt kjent med et personvernbrudd som gjelder data vi behandler på kundens vegne, med den informasjonen vi har som kunden trenger for å vurdere varsling til Datatilsynet og de registrerte.',
            'Asoldi bistår med informasjon kunden trenger til konsekvensvurderinger, når det er relevant og rimelig.',
          ]}
        />
      </LegalSection>

      <LegalSection id="opphor" title="10. Sletting og håndtering ved opphør">
        <LegalList
          items={[
            'Når abonnementet avsluttes, får kunden tilgang til nettsidefilene slik siden står, innen syv (7) virkedager, i tråd med vilkårene.',
            'Etter eksport sletter eller anonymiserer Asoldi personopplysninger vi behandler på kundens vegne innen 30 dager, med mindre kunden ber om tidligere sletting, eller lov krever lengre oppbevaring (for eksempel bokføringsloven for fakturagrunnlag i Asoldis egne systemer).',
            'Sikkerhetskopier fases ut i den ordinære rotasjonen etter sletting.',
            'Asoldi kan beholde opplysninger som er strengt nødvendige for å dokumentere at sletting er gjennomført, eller for å forsvare et rettskrav.',
          ]}
        />
      </LegalSection>

      <LegalSection id="revisjon" title="11. Revisjon og dokumentasjon">
        <p>
          Asoldi stiller til rådighet den informasjonen som er nødvendig for å vise at denne avtalen overholdes.
          Kunden kan be om en skriftlig redegjørelse. Fysisk eller teknisk revisjon hos underleverandør avtales
          forhånd og gjennomføres på en måte som ikke truer sikkerheten for andre kunder. Kostnader ved revisjon
          kunden selv initierer, bæres av kunden med mindre revisjonen avdekker vesentlig brudd fra Asoldis side.
        </p>
      </LegalSection>

      <LegalSection id="overforing" title="12. Overføring utenfor EØS">
        <p>
          Dersom en underleverandør behandler opplysninger utenfor EØS (for eksempel GitHub i USA), skjer
          overføringen bare med gyldig grunnlag, typisk EUs standardkontraktsvilkår eller en rubrikkavgjørelse,
          sammen med de tiltakene som da kreves.
        </p>
      </LegalSection>

      <LegalSection id="taushet" title="13. Taushetsplikt">
        <p>
          Asoldi pålegger personer som får tilgang til personopplysningene taushetsplikt. Plikten gjelder også
          etter at oppdraget er avsluttet.
        </p>
      </LegalSection>

      <LegalSection id="ansvar" title="14. Ansvar">
        <p>
          Hver part er ansvarlig for brudd på egne plikter etter personvernregelverket. Asoldis erstatningsansvar
          overfor kunden følger ansvarsbegrensningen i{' '}
          <Link to="/vilkar" className={legalLinkClass}>
            vilkårene
          </Link>
          {' '}(samlet tak tilsvarende seks måneders abonnement eks. mva, med mindre ufravikelig lov gir et mer
          omfattende krav).
        </p>
      </LegalSection>

      <LegalSection id="varighet" title="15. Varighet og endringer">
        <p>
          Avtalen gjelder så lenge Asoldi behandler personopplysninger på kundens vegne. Vi kan oppdatere teksten
          når tjenesten eller underleverandører endres. Vesentlige endringer varsles på nettstedet. For en
          allerede signert tjenesteavtale gjelder denne siden slik den sto på signeringsdatoen, med mindre
          partene blir enige om noe annet.
        </p>
      </LegalSection>

      <LegalCallout title="Slik aksepteres avtalen">
        <p>
          Databehandleravtalen inngås sammen med tjenesteavtalen: når kunden godtar vilkårene, signerer et tilbud
          i kundeportalen, eller lar Asoldi hoste og drifte nettsiden. Den trenger ikke et eget underskriftsfelt i
          tillegg til tjenesteavtalen.
        </p>
      </LegalCallout>
    </LegalLayout>
  );
};
