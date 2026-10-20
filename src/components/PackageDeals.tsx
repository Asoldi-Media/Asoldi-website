import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, ArrowRight, ChevronDown, Globe } from 'lucide-react';
import { Link } from 'react-router-dom';

const websiteTiers = [
  { 
    name: 'Starter', 
    price: 499,
    features: [
      "Full nettsideutvikling",
      "Hosting og vedlikehold",
      "Kontaktskjema & standard seksjoner"
    ]
  },
  { 
    name: 'SEO', 
    price: 1499,
    features: [
      "Full nettsideutvikling",
      "Hosting og vedlikehold",
      "Rank høyere på google, google maps og ai"
    ]
  },
  { 
    name: 'Nettbutikk', 
    price: 1999,
    features: [
      "Full nettsideutvikling",
      "Hosting og vedlikehold",
      "Selg i nettbutikk med e-commerce funksjonalitet"
    ]
  },
  { 
    name: 'Skreddersydd', 
    price: null,
    features: [
      "Full nettsideutvikling",
      "Hosting og vedlikehold",
      "Skreddersydde funksjoner etter behov"
    ]
  }
];

type DealType = 'starter' | 'marketing';

export const PackageDeals = () => {
  const [activeDeal, setActiveDeal] = useState<DealType>('starter');
  const [selectedWebTier, setSelectedWebTier] = useState(websiteTiers[0]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  const smmPrice = 2999;
  const emailPrice = 5999;
  const starterNettsideValue = 499;
  const starterMarketingValue = 1999;
  const starterGuideValue = 999;
  const starterOriginal = starterNettsideValue + starterMarketingValue + starterGuideValue;
  const starterDeal = Math.round(starterOriginal * 0.5);
  const fmtDeal = (n: number) => `${n.toLocaleString('nb-NO')},-`;
  const discount = 0.2;

  const calculateTotal = () => {
    if (selectedWebTier.price === null) return 'Etter avtale';
    const total = (smmPrice + emailPrice + selectedWebTier.price) * (1 - discount);
    return Math.round(total).toLocaleString('nb-NO') + ',- /mnd';
  };

  const calculateOriginalTotal = () => {
    if (selectedWebTier.price === null) return null;
    return (smmPrice + emailPrice + selectedWebTier.price).toLocaleString('nb-NO') + ',- /mnd';
  };

  return (
    <section className="py-20 px-6 md:px-10 bg-[#050505] overflow-hidden">
      <div className="max-w-[1440px] mx-auto">
        <div className="text-center mb-10">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="flex items-center justify-center gap-4 mb-4"
          >
            <div className="w-12 h-[2px] bg-[#FF5B00]" />
            <span className="text-[#FF5B00] font-medium tracking-wider uppercase text-sm">Pakke Deals</span>
            <div className="w-12 h-[2px] bg-[#FF5B00]" />
          </motion.div>
          <motion.h2
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
            className="text-4xl md:text-5xl font-medium text-white mb-8"
          >
            Eksklusive <span className="text-[#FF5B00] font-serif italic">Pakketilbud</span>
          </motion.h2>

          {/* Toggle Switch */}
          <div className="flex justify-center mb-10">
            <div className="bg-[#121212] p-1 rounded-full border border-white/10 flex relative w-full max-w-md overflow-hidden">
              <motion.div 
                className="absolute top-1 bottom-1 rounded-full bg-[#FF5B00]"
                initial={false}
                animate={{ 
                  x: activeDeal === 'starter' ? 0 : '100%', 
                  width: '50%' 
                }}
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
              />
              <button 
                onClick={() => setActiveDeal('starter')}
                className={`relative z-10 flex-1 py-2.5 rounded-full text-xs font-medium transition-colors duration-300 ${activeDeal === 'starter' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
              >
                STARTER PAKKE
              </button>
              <button 
                onClick={() => setActiveDeal('marketing')}
                className={`relative z-10 flex-1 py-2.5 rounded-full text-xs font-medium transition-colors duration-300 ${activeDeal === 'marketing' ? 'text-white' : 'text-gray-400 hover:text-white'}`}
              >
                MARKEDSFØRINGSPAKKE
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-center">
          <AnimatePresence mode="wait">
            {activeDeal === 'starter' ? (
              <motion.div
                key="starter"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.4 }}
                className="w-full max-w-5xl bg-[#121212] border border-white/10 rounded-[32px] overflow-hidden flex flex-col md:flex-row shadow-2xl min-h-[600px] relative"
              >
                <div className="p-6 md:p-8 flex-[0.45] flex flex-col justify-between border-b md:border-b-0 md:border-r border-white/10 bg-gradient-to-b from-[#1a1a1a] to-[#121212]">
                  <div>
                    <div className="flex items-center gap-4 mb-6">
                      <h3 className="text-3xl font-medium text-white">Starter pakke</h3>
                    </div>

                    <p className="text-gray-400 text-sm leading-relaxed mb-6">
                      Den perfekte oppstartspakken for nye bedrifter. Alt du trenger for å etablere din digitale tilstedeværelse til en uslåelig pris.
                    </p>

                    {/* Calculation Section */}
                    <div className="space-y-3 mb-6">
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-gray-300">Nettside: Starter</span>
                        <span className="text-white font-medium">{starterNettsideValue},- /mnd</span>
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-gray-300">Sosiale medier: Starter</span>
                        <span className="text-white font-medium">{starterMarketingValue},- /mnd</span>
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-gray-300">Starter guide pdf</span>
                        <span className="text-white font-medium">{starterGuideValue},-</span>
                      </div>
                      <div className="h-[1px] bg-white/10 my-2" />
                    </div>

                    <div className="flex items-baseline gap-4 mb-6">
                      <span className="text-lg md:text-xl text-gray-500 line-through">{fmtDeal(starterOriginal)}</span>
                      <span className="text-3xl md:text-4xl font-medium text-white">{fmtDeal(starterDeal)} /mnd</span>
                    </div>

                    <div className="bg-[#FF5B00]/10 border border-[#FF5B00]/20 rounded-2xl p-4 mb-6">
                      <div className="text-[#FF5B00] font-bold text-sm mb-1">50% Rabatt inkludert</div>
                      <p className="text-gray-400 text-xs">
                        Du sparer {(starterOriginal - starterDeal).toLocaleString('nb-NO')} kr på denne pakken.
                      </p>
                    </div>
                  </div>

                  
                  <Link to="/booking" className="w-full bg-white text-black py-4 rounded-xl font-medium text-lg hover:bg-[#FF5B00] hover:text-white transition-all duration-300 flex items-center justify-center gap-2">
                    Book møte
                  </Link>
                </div>

                {/* Right Side - Inclusions */}
                <div className="p-6 md:p-8 flex-[0.55] bg-[#0a0a0a]/50 flex flex-col relative">
                  {/* Badge - Top Right */}
                  <div className="absolute top-6 right-6 z-20 bg-[#FF5B00] text-white px-6 py-3 rounded-2xl font-bold text-sm shadow-lg transform rotate-2 hover:rotate-0 transition-transform duration-300">
                    Kun for bedrifter under 1 år
                  </div>

                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-8 h-[2px] bg-[#FF5B00]" />
                    <h4 className="text-lg font-medium text-white">Hva er inkludert</h4>
                  </div>
                  
                  <div className="flex-grow overflow-y-auto pr-2 custom-scrollbar">
                    <div className="space-y-6">
                      {/* Block 1 */}
                      <div className="pb-6 border-b border-white/10">
                        <h5 className="text-lg font-medium text-white mb-3">Nettside: Starter</h5>
                        <ul className="space-y-2 mb-4">
                          {websiteTiers[0].features.map((feature, idx) => (
                            <li key={idx} className="flex items-center gap-3 text-gray-400 text-[13px]">
                              <div className="w-1.5 h-1.5 rounded-full bg-white" />
                              {feature}
                            </li>
                          ))}
                        </ul>
                        <Link to="/services/web-development" className="inline-block text-xs text-gray-300 hover:text-white border border-white/20 px-5 py-2 rounded-xl transition-colors">
                          les mer om tjeneste
                        </Link>
                      </div>

                      {/* Block 2 */}
                      <div className="pb-6 border-b border-white/10">
                        <h5 className="text-lg font-medium text-white mb-3">Sosiale medier: Starter</h5>
                        <ul className="space-y-2 mb-4">
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            Strategi og innholdsplan
                          </li>
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            Sosial medie opprettholdelse
                          </li>
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            Kampanjestrategi & planlegging
                          </li>
                        </ul>
                        <Link to="/services/social-media" className="inline-block text-xs text-gray-300 hover:text-white border border-white/20 px-5 py-2 rounded-xl transition-colors">
                          les mer om tjeneste
                        </Link>
                      </div>

                      {/* Block 3 */}
                      <div className="pb-4">
                        <h5 className="text-lg font-medium text-white mb-3">Starter guide pdf</h5>
                        <ul className="space-y-2 mb-4">
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            Regnskapsintroduksjon
                          </li>
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            Tips for oppstart i Norge
                          </li>
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            Markedsførings-essentials
                          </li>
                        </ul>
                        <Link to="/about" className="inline-block text-xs text-gray-300 hover:text-white border border-white/20 px-5 py-2 rounded-xl transition-colors">
                          les mer om tjeneste
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="marketing"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                transition={{ duration: 0.4 }}
                className="w-full max-w-5xl bg-[#121212] border border-white/10 rounded-[32px] overflow-hidden flex flex-col md:flex-row shadow-2xl min-h-[600px]"
              >
                {/* Left Side - Product Summary */}
                <div className="p-6 md:p-8 flex-[0.45] flex flex-col justify-between border-b md:border-b-0 md:border-r border-white/10 bg-gradient-to-b from-[#1a1a1a] to-[#121212]">
                  <div>
                    <div className="flex items-center gap-4 mb-6">
                      <h3 className="text-3xl font-medium text-white">Markedsførings pakke</h3>
                    </div>

                    <p className="text-gray-400 text-sm leading-relaxed mb-6">
                      Vår mest populære kombinasjon for maksimal vekst. Få full dekning på tvers av alle digitale kanaler med 20% rabatt.
                    </p>

                    {/* Calculation Section with Dropdown */}
                    <div className="space-y-3 mb-6">
                      <div className="flex justify-between items-center text-sm">
                        <div className="flex items-center gap-2">
                          <span className="text-gray-300">Nettside Pakke</span>
                          <div className="relative">
                            <button 
                              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                              className="bg-white/5 border border-white/10 rounded-lg px-2 py-1 flex items-center gap-1 text-white text-xs hover:bg-white/10 transition-colors"
                            >
                              {selectedWebTier.name}
                              <ChevronDown size={12} className={`transition-transform duration-300 ${isDropdownOpen ? 'rotate-180' : ''}`} />
                            </button>
                            {isDropdownOpen && (
                              <div className="absolute top-full left-0 mt-1 bg-[#1a1a1a] border border-white/10 rounded-lg overflow-hidden z-20 shadow-2xl min-w-[120px]">
                                {websiteTiers.map((tier) => (
                                  <button
                                    key={tier.name}
                                    onClick={() => {
                                      setSelectedWebTier(tier);
                                      setIsDropdownOpen(false);
                                    }}
                                    className="w-full px-4 py-2 text-left text-white text-xs hover:bg-[#FF5B00] transition-colors flex justify-between items-center"
                                  >
                                    <span>{tier.name}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                        <span className="text-white font-medium">{selectedWebTier.price ? `${selectedWebTier.price},- /mnd` : 'Velg'}</span>
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-gray-300">Sosiale medier: Vekst</span>
                        <span className="text-white font-medium">{smmPrice},- /mnd</span>
                      </div>
                      <div className="flex justify-between items-center text-sm">
                        <span className="text-gray-300">E-post markedsføring: Vekst</span>
                        <span className="text-white font-medium">{emailPrice},- /mnd</span>
                      </div>
                      <div className="h-[1px] bg-white/10 my-2" />
                    </div>

                    <div className="flex items-baseline gap-4 mb-6">
                      {calculateOriginalTotal() && (
                        <span className="text-lg md:text-xl text-gray-500 line-through">{calculateOriginalTotal()}</span>
                      )}
                      <span className="text-3xl md:text-4xl font-medium text-white">{calculateTotal()}</span>
                    </div>

                    <div className="bg-[#FF5B00]/10 border border-[#FF5B00]/20 rounded-2xl p-4 mb-6">
                      <div className="text-[#FF5B00] font-bold text-sm mb-1">20% Rabatt inkludert</div>
                      <p className="text-gray-400 text-xs">
                        Du sparer over {(selectedWebTier.price ? Math.round((smmPrice + emailPrice + selectedWebTier.price) * 0.2) : 1800).toLocaleString('nb-NO')} kr hver måned.
                      </p>
                    </div>
                  </div>
                  
                  <Link to="/booking" className="w-full bg-white text-black py-4 rounded-xl font-medium text-lg hover:bg-[#FF5B00] hover:text-white transition-all duration-300 flex items-center justify-center gap-2">
                    Book møte
                  </Link>
                </div>

                {/* Right Side - Inclusions */}
                <div className="p-6 md:p-8 flex-[0.55] bg-[#0a0a0a]/50 flex flex-col">
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-8 h-[2px] bg-[#FF5B00]" />
                    <h4 className="text-lg font-medium text-white">Hva er inkludert</h4>
                  </div>
                  
                  <div className="flex-grow overflow-y-auto pr-2 custom-scrollbar">
                    <div className="space-y-6">
                      {/* Block 1 */}
                      <div className="pb-6 border-b border-white/10">
                        <h5 className="text-lg font-medium text-white mb-3">Sosiale medier: Vekst</h5>
                        <ul className="space-y-2 mb-4">
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            Strategi og innholdsplan
                          </li>
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            Sosial medie opprettholdelse
                          </li>
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            Kampanjestrategi & planlegging
                          </li>
                        </ul>
                        <Link to="/services/social-media" className="inline-block text-xs text-gray-300 hover:text-white border border-white/20 px-5 py-2 rounded-xl transition-colors">
                          les mer om tjeneste
                        </Link>
                      </div>

                      {/* Block 2 */}
                      <div className="pb-6 border-b border-white/10">
                        <h5 className="text-lg font-medium text-white mb-3">Nettside: {selectedWebTier.name}</h5>
                        <ul className="space-y-2 mb-4">
                          {selectedWebTier.features.map((feature, idx) => (
                            <li key={idx} className="flex items-center gap-3 text-gray-400 text-[13px]">
                              <div className="w-1.5 h-1.5 rounded-full bg-white" />
                              {feature}
                            </li>
                          ))}
                        </ul>
                        <Link to="/services/web-development" className="inline-block text-xs text-gray-300 hover:text-white border border-white/20 px-5 py-2 rounded-xl transition-colors">
                          les mer om tjeneste
                        </Link>
                      </div>

                      {/* Block 3 */}
                      <div className="pb-2">
                        <h5 className="text-lg font-medium text-white mb-3">E-post markedsføring: Vekst</h5>
                        <ul className="space-y-2 mb-4">
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            4 kampanjer per måned
                          </li>
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            Håndtering av opptil 5 flows
                          </li>
                          <li className="flex items-center gap-3 text-gray-400 text-[13px]">
                            <div className="w-1.5 h-1.5 rounded-full bg-white" />
                            Avansert segmentering
                          </li>
                        </ul>
                        <Link to="/services/email-marketing" className="inline-block text-xs text-gray-300 hover:text-white border border-white/20 px-5 py-2 rounded-xl transition-colors">
                          les mer om tjeneste
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
};
