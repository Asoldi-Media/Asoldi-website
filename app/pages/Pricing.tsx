import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, ArrowRight, Minus } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { SEO } from '../components/SEO';
import { getServiceSchema } from '../structuredData';
import { BUSINESS, SITE_URL } from '../config';
import { WEBSITE_PRODUCTS } from '../data/websiteProducts';

const services = [
  "Nettsideutvikling",
  "Sosiale Medier",
  "E-post Markedsføring",
  "Innholdsproduksjon",
  "Konsultasjon"
];

const serviceSalesText: Record<string, { title: string, desc: string }> = {
  "Nettsideutvikling": { title: "Webutvikling", desc: "Alt du trenger for å bygge en kraftfull og skalerbar tilstedeværelse på nett." },
  "Sosiale Medier": { title: "Sosiale Medier", desc: "Alt du trenger for å vokse ditt publikum og gjøre følgere til kunder." },
  "E-post Markedsføring": { title: "E-post Markedsføring", desc: "Alt du trenger for å fange leads og pleie dem til lojale kunder." },
  "Innholdsproduksjon": { title: "Kreativ Media", desc: "Alt du trenger for å fortelle din merkevares historie visuelt." },
  "Konsultasjon": { title: "Konsultasjon", desc: "Profesjonell hjelp på tvers av tjenestene våre når du trenger sparring, problemløsning og tydelige neste steg." }
};

const smmBaseData = [
  {
    id: "Starter",
    name: "Starter",
    description: "Essensiell tilstedeværelse i sosiale medier.",
    credits: 3,
    defaultPosts: 2,
    normalPrice: "1 999,-/mnd",
    prodPrice: "5 999,-/mnd",
    features: [
      "Strategi og innholdsplan",
      "Sosial medie opprettholdelse",
      "Kampanjestrategi & planlegging",
      "Grunnleggende annonsestyring",
      "Månedlig rapportering",
      "10% rabatt på nettside"
    ],
    prodFeatures: [
      "Fullservice videoproduksjon",
      "Dedikert Account Manager"
    ]
  },
  {
    id: "Growth",
    name: "Vekst",
    description: "Aggressiv vekststrategi for din bedrift.",
    credits: 6,
    defaultPosts: 4,
    normalPrice: "2 999,-/mnd",
    prodPrice: "7 999,-/mnd",
    popular: true,
    features: [
      "Alle tjenester fra Starter",
      "Profiloptimalisering",
      "Aktiv kundeoppfølging og meldingstjeneste",
      "A/B-testing av annonser",
      "Rapportering hver 14. dag",
      "30% rabatt på nettside & gratis hosting"
    ],
    prodFeatures: [
      "Fullservice videoproduksjon",
      "Dedikert Account Manager"
    ]
  },
  {
    id: "Premium",
    name: "Premium",
    description: "Full overtagelse av dine sosiale medier.",
    credits: 9,
    defaultPosts: 6,
    normalPrice: "3 999,-/mnd",
    prodPrice: "9 999,-/mnd",
    features: [
      "Alle tjenester fra Vekst",
      "Dedikert Account Manager & prioritert support",
      "Ukentlige rapporter & strategimøter",
      "40% rabatt på nettside & gratis hosting"
    ],
    prodFeatures: [
      "Fullservice videoproduksjon",
      "Dedikert Account Manager"
    ]
  }
];

const pricingData: Record<string, any[]> = {
  "Nettsideutvikling": WEBSITE_PRODUCTS,
  "Sosiale Medier": [],
  "E-post Markedsføring": [
    {
      name: "Starter",
      price: "1 499,-/mnd",
      description: "Etabler en konsistent e-post-tilstedeværelse. Perfekt for nye merkevarer.",
      includedFeatures: [
        "2 kampanjer per måned",
        "Håndtering av 2 kjerne-flows",
        "Grunnleggende segmentering",
        "Månedlig resultatrapport",
        "E-post strategi & kalender",
        "Profesjonell tekst & design"
      ],
      notIncludedFeatures: [
        "A/B-testing",
        "Avanserte atferds-flows",
        "Dedikert Slack-support"
      ]
    },
    {
      name: "Vekst",
      price: "5 999,-/mnd",
      description: "Maksimer kundeverdien gjennom målrettet automatisering.",
      popular: true,
      includedFeatures: [
        "4 kampanjer per måned",
        "Håndtering av opptil 5 flows",
        "Avansert segmentering",
        "Rapportering hver 14. dag",
        "A/B-testing",
        "Profesjonell tekst & design",
        "E-post strategi & kalender"
      ],
      notIncludedFeatures: [
        "Mikro-segmentering",
        "Dedikert Slack-support"
      ]
    },
    {
      name: "Premium",
      price: "9 999,-/mnd",
      description: "En fullstendig administrert e-post-maskin for etablerte merkevarer.",
      includedFeatures: [
        "8 kampanjer per måned",
        "Ubegrenset flow-håndtering",
        "Mikro-segmentering",
        "Ukentlig rapportering",
        "Kontinuerlig A/B-testing",
        "Profesjonell tekst & design",
        "E-post strategi & kalender",
        "Dedikert Slack-support"
      ],
      notIncludedFeatures: []
    }
  ],
  "Innholdsproduksjon": [
    {
      name: "Skreddersydd Produksjon",
      price: "Etter avtale",
      description: "Skreddersydd foto- og videoproduksjon for din bedrift. Book et møte for å diskutere dine behov.",
      features: [
        "Skreddersydd konseptutvikling",
        "Profesjonell foto og video",
        "Avansert redigering",
        "Optimalisert for alle plattformer"
      ],
      popular: true,
    }
  ],
  "Konsultasjon": [
    {
      name: "Konsultasjon",
      price: "1 000,-/time eks. mva",
      description: "Faglig hjelp med markedsføring, e-post markedsføring, webdesign og innholdsproduksjon.",
      features: [
        "Profesjonell hjelp på timebasis",
        "Rådgivning for markedsføring, e-post markedsføring, webdesign og innholdsproduksjon",
        "Hjelp med spørsmål, bekymringer og konkrete problemer",
        "Vi går gjennom utfordringen og foreslår løsninger du kan jobbe videre med",
        "Oppsummerende analyseskjema etter møtet",
        "Oversikt over hva som ble diskutert og hva vi fant ut"
      ],
      popular: true,
    }
  ]
};

export const Pricing = () => {
  const location = useLocation();
  const [activeService, setActiveService] = useState(services[0]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const serviceParam = params.get('service');
    if (serviceParam && services.includes(serviceParam)) {
      setActiveService(serviceParam);
    }
  }, [location]);
  const [smmMode, setSmmMode] = useState<'Normal' | 'Produksjon'>('Normal');
  const [smmMix, setSmmMix] = useState<Record<string, number>>({
    Starter: 2,
    Growth: 4,
    Premium: 6
  });

  const handleMixChange = (id: string, posts: number) => {
    setSmmMix(prev => ({ ...prev, [id]: posts }));
  };

  return (
    <div className="min-h-screen bg-white">
      <SEO
        title={`Priser – ${BUSINESS.shortName} | Nettsider, sosiale medier og markedsføring`}
        description="Transparente priser på nettsideutvikling, sosiale medier, e-post markedsføring og innholdsproduksjon. Velg den planen som passer din bedrift."
        path="/pricing"
        structuredData={getServiceSchema('Priser', 'Prisplaner for nettsider, sosiale medier og markedsføring.', SITE_URL + '/pricing')}
      />
      {/* Header Section - Black */}
      <div className="pt-32 pb-24 px-6 md:px-10 bg-[#050505]">
        <div className="max-w-7xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center justify-center gap-4 mb-4"
          >
            <div className="w-12 h-[2px] bg-[#FF5B00]" />
            <span className="text-[#FF5B00] font-medium tracking-wider uppercase">Prisplaner</span>
            <div className="w-12 h-[2px] bg-[#FF5B00]" />
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="text-5xl md:text-7xl font-medium text-white mb-6"
          >
            Voks raskere med den <span className="text-[#FF5B00] font-serif italic">rette planen.</span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="text-gray-400 text-lg max-w-2xl mx-auto"
          >
            Betal for det du trenger. Velg en tjeneste nedenfor for å se våre transparente priser.
          </motion.p>
        </div>
      </div>

      {/* Full-width Service Selector Tabs */}
      <div className="w-full border-b border-gray-200 bg-white">
        <div className="max-w-7xl mx-auto flex overflow-x-auto hide-scrollbar">
          {services.map((service) => (
            <button
              key={service}
              onClick={() => setActiveService(service)}
              className={`whitespace-nowrap flex-1 min-w-[160px] px-6 py-5 text-sm font-medium transition-all duration-300 relative ${
                activeService === service
                  ? 'text-black bg-[#f8f9fa]'
                  : 'text-gray-500 hover:text-gray-800 bg-white hover:bg-gray-50'
              }`}
            >
              {activeService === service && (
                <motion.div 
                  layoutId="activeTabPricing"
                  className="absolute bottom-0 left-0 right-0 h-[3px] bg-[#FF5B00]" 
                />
              )}
              {service}
            </button>
          ))}
        </div>
      </div>

      {/* Sales Text & Pricing Section - Light Background */}
      <div className="w-full bg-[#f8f9fa] pt-16 pb-24 px-6 md:px-10">
        <div className="max-w-6xl mx-auto">
          
          {/* Dynamic Sales Text */}
          <AnimatePresence mode="wait">
            <motion.div
              key={`text-${activeService}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className="text-center mb-12"
            >
              <h2 className="text-3xl md:text-4xl font-bold text-black mb-4 flex items-center justify-center gap-3">
                <span className="text-[#FF5B00] text-2xl">✦</span>
                {serviceSalesText[activeService].title}
              </h2>
              <p className="text-gray-600 text-lg mb-8">
                {serviceSalesText[activeService].desc}
              </p>

              {/* SMM Mode Toggle */}
              {(activeService === "Sosiale Medier" || activeService === "Social Media Marketing") && (
                <div className="flex flex-col items-center justify-center mt-4">
                  <div className="bg-gray-200 p-1 rounded-full inline-flex mb-4">
                    <button
                      onClick={() => setSmmMode('Normal')}
                      className={`px-6 py-2 rounded-full text-sm font-bold transition-all ${smmMode === 'Normal' ? 'bg-white text-black shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
                    >
                      Normal
                    </button>
                    <button
                      onClick={() => setSmmMode('Produksjon')}
                      className={`px-6 py-2 rounded-full text-sm font-bold transition-all ${smmMode === 'Produksjon' ? 'bg-white text-black shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}
                    >
                      Produksjon
                    </button>
                  </div>
                  <p className="text-sm text-gray-500 max-w-md mx-auto">
                    <span className="font-semibold text-black">Produksjon</span> inkluderer profesjonell foto- og videoproduksjon for innholdet ditt.
                  </p>
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {/* Pricing Cards */}
          <div className="relative min-h-[600px] bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeService}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.3 }}
                className={`grid grid-cols-1 ${
                  activeService === "Nettsideutvikling" 
                    ? "md:grid-cols-2 lg:grid-cols-4" 
                    : activeService === "Innholdsproduksjon" || activeService === "Konsultasjon"
                    ? "max-w-xl mx-auto w-full"
                    : "md:grid-cols-2 lg:grid-cols-3"
                } divide-y md:divide-y-0 md:divide-x divide-gray-200 w-full`}
              >
                {(activeService === "Sosiale Medier" || activeService === "Social Media Marketing") ? (
                  smmBaseData.map((plan) => {
                    const posts = smmMix[plan.id];
                    const ads = plan.credits - posts;
                    const price = smmMode === 'Normal' ? plan.normalPrice : plan.prodPrice;
                    const features = smmMode === 'Normal' ? plan.features : [...plan.features, ...plan.prodFeatures];

                    return (
                      <div key={plan.id} className="relative p-10 flex flex-col bg-white">
                        {/* Header */}
                        <div className="text-center mb-8">
                          <h3 className="text-2xl font-bold text-black mb-3 flex items-center justify-center gap-2">
                            <div className={`w-3 h-3 rounded-sm ${plan.popular ? 'bg-[#FF5B00]' : 'bg-gray-300'}`} />
                            {plan.name}
                          </h3>
                          <p className="text-gray-500 text-sm h-10">{plan.description}</p>
                        </div>
                        
                        {/* Price */}
                        <div className="text-center mb-8">
                          <div className="flex items-baseline justify-center gap-1">
                            <span className="text-4xl font-bold text-black">{price.replace('/mnd', '')}</span>
                            {price.includes('/mnd') && <span className="text-lg text-gray-400 font-medium">/mnd</span>}
                          </div>
                        </div>

                        {/* Mix Slider */}
                        <div className="mb-8">
                          <div className="flex justify-between text-sm font-bold text-black mb-3">
                            <span>{posts} Innlegg/uke</span>
                            <span>{ads} Annonser/mnd</span>
                          </div>
                          <input 
                            type="range" 
                            min="0" 
                            max={plan.credits} 
                            value={posts} 
                            onChange={(e) => handleMixChange(plan.id, parseInt(e.target.value))}
                            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-[#FF5B00]"
                          />
                          <p className="text-xs text-center text-gray-500 mt-3">1 ukentlig innlegg = 1 annonse/måned</p>
                        </div>

                        {/* Features */}
                        <div className="flex-1 mb-10">
                          <p className="text-sm font-bold text-black mb-4 uppercase tracking-wider">Inkluderer:</p>
                          <ul className="space-y-4">
                            {/* Special Production Highlight */}
                            {smmMode === 'Produksjon' && (
                              <li className="flex items-start gap-3 text-black font-bold text-sm">
                                <div className="bg-green-500 p-1 rounded-full shrink-0 mt-0.5">
                                  <Check size={14} className="text-white" />
                                </div>
                                <span className="pt-0.5">Foto og video på location</span>
                              </li>
                            )}

                            {/* Credits Highlight */}
                            <li className="flex items-start gap-3 text-black font-bold text-sm">
                              <div className="bg-green-100 p-1 rounded-full shrink-0 mt-0.5">
                                <Check size={14} className="text-green-600" />
                              </div>
                              <span className="pt-0.5">{plan.credits} innhold credits</span>
                            </li>

                            {features.map((feature: string, i: number) => (
                              <li key={i} className="flex items-start gap-3 text-gray-600 text-sm">
                                <div className="bg-orange-100/50 p-1 rounded-full shrink-0 mt-0.5">
                                  <Check size={14} className="text-[#FF5B00]" />
                                </div>
                                <span className="pt-0.5">{feature}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* CTA */}
                        <Link
                          to="/booking"
                          className={`w-full py-4 rounded-md font-bold flex items-center justify-center gap-2 transition-all duration-300 mt-auto ${
                            plan.popular
                              ? 'bg-[#FF5B00] text-white hover:bg-[#e85300]'
                              : 'bg-white text-black border-2 border-[#FF5B00] hover:bg-orange-50'
                          }`}
                        >
                          Book konsultasjon
                        </Link>
                      </div>
                    );
                  })
                ) : (
                  (pricingData[activeService] || []).map((plan, index) => (
                    <div
                      key={plan.name}
                      className="relative p-10 flex flex-col bg-white"
                    >
                      {/* Header */}
                      <div className="text-center mb-8">
                        <h3 className="text-2xl font-bold text-black mb-3 flex items-center justify-center gap-2">
                          <div className={`w-3 h-3 rounded-sm ${plan.popular ? 'bg-[#FF5B00]' : 'bg-gray-300'}`} />
                          {plan.name}
                        </h3>
                        <p className="text-gray-500 text-sm h-10">{plan.description}</p>
                      </div>
                      
                      {/* Price */}
                      <div className="text-center mb-8">
                        <div className="flex items-baseline justify-center gap-1">
                          <span className={`${plan.price === 'Etter avtale' ? 'text-3xl' : 'text-4xl'} font-bold text-black`}>{plan.price.replace('/mnd', '')}</span>
                          {plan.price.includes('/mnd') && <span className="text-lg text-gray-400 font-medium">/mnd</span>}
                        </div>
                      </div>

                      {/* Features */}
                      <div className="flex-1 mb-10">
                        <p className="text-sm font-bold text-black mb-4 uppercase tracking-wider">Inkluderer:</p>
                        <ul className="space-y-4">
                          {plan.includedFeatures ? (
                            <>
                              {plan.includedFeatures.map((feature: string, i: number) => (
                                <li key={`inc-${i}`} className="flex items-start gap-3 text-gray-600 text-sm">
                                  <div className="bg-orange-100/50 p-1 rounded-full shrink-0 mt-0.5">
                                    <Check size={14} className="text-[#FF5B00]" />
                                  </div>
                                  <span className="pt-0.5">{feature}</span>
                                </li>
                              ))}
                              {plan.notIncludedFeatures?.map((feature: string, i: number) => (
                                <li key={`not-${i}`} className="flex items-start gap-3 text-gray-400 text-sm">
                                  <div className="bg-gray-100 p-1 rounded-full shrink-0 mt-0.5">
                                    <Minus size={14} className="text-gray-400" />
                                  </div>
                                  <span className="pt-0.5">{feature}</span>
                                </li>
                              ))}
                            </>
                          ) : (
                            plan.features?.map((feature: string, i: number) => (
                              <li key={i} className="flex items-start gap-3 text-gray-600 text-sm">
                                <div className="bg-orange-100/50 p-1 rounded-full shrink-0 mt-0.5">
                                  <Check size={14} className="text-[#FF5B00]" />
                                </div>
                                <span className="pt-0.5">{feature}</span>
                              </li>
                            ))
                          )}
                        </ul>
                      </div>

                      {/* CTA */}
                      <Link
                        to="/booking"
                        className={`w-full py-4 rounded-md font-bold flex items-center justify-center gap-2 transition-all duration-300 mt-auto ${
                          plan.popular
                            ? 'bg-[#FF5B00] text-white hover:bg-[#e85300]'
                            : 'bg-white text-black border-2 border-[#FF5B00] hover:bg-orange-50'
                        }`}
                      >
                        Book konsultasjon
                      </Link>
                    </div>
                  ))
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
};
