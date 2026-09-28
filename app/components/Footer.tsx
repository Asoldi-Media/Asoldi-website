import React from 'react';
import { Button } from './Button';
import { motion } from 'motion/react';
import { Twitter, Youtube, Instagram, Facebook, Github, Mail, Phone, MapPin } from 'lucide-react';
import { useLocation, Link } from 'react-router-dom';
import { useEmployeeAuth } from '../contexts/EmployeeAuthContext';

export const Footer = () => {
  const currentYear = new Date().getFullYear();
  const location = useLocation();
  const { isEmployee } = useEmployeeAuth();

  if (location.pathname === '/booking') {
    return null;
  }

  return (
    <footer className="bg-[#050505] border-t border-white/5 pt-24 pb-12 px-6 md:px-10">
      <div className="max-w-[1440px] mx-auto">
        {/* Pre-footer CTA */}
        <div className="text-center mb-24 border-b border-white/5 pb-24">
          <motion.h2 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-4xl md:text-6xl lg:text-7xl font-medium mb-8 max-w-5xl mx-auto leading-tight text-white"
          >
            Klar for å skalere din <span className="text-[#FF5B00] font-serif italic">bedrift?</span>
          </motion.h2>
          
          <motion.p 
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1 }}
            className="text-gray-400 text-lg md:text-xl max-w-2xl mx-auto mb-12"
          >
            Bli en av de suksessfulle bedriftene som stoler på Asoldi for sin digitale tilstedeværelse.
          </motion.p>
          
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.2 }}
          >
            <Button text="Book konsultasjon" href="/booking" className="bg-[#FF5B00] text-white hover:bg-white hover:text-black" />
          </motion.div>
        </div>

        {/* Main Footer Content */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-12 mb-16">
            {/* Brand */}
            <div className="space-y-6">
                <div className="flex items-center gap-2">
                    <img src="/media/Untitled-1.png" alt="Asoldi" className="h-8 w-auto" />
                </div>
                <p className="text-gray-400 text-sm leading-relaxed max-w-xs">
                    Studentdrevet digitalt byrå i Trondheim. Vi hjelper bedrifter med å vokse på nett gjennom høykvalitets nettsider og målrettet markedsføring.
                </p>
                <div className="text-gray-400 text-sm space-y-1">
                  <div className="flex items-center gap-2">
                    <MapPin size={14} className="text-[#FF5B00]" />
                    <span>Østre berg 10, 7051 Trondheim</span>
                  </div>
                </div>
            </div>

            {/* Navigation */}
            <div>
                <h4 className="text-white font-medium mb-6 text-lg">Navigasjon</h4>
                <ul className="space-y-4 text-gray-400 text-sm">
                    <li><Link to="/" className="hover:text-[#FF5B00] transition-colors block w-fit">Hjem</Link></li>
                    <li><Link to="/services/web-development" className="hover:text-[#FF5B00] transition-colors block w-fit">Tjenester</Link></li>
                    <li><Link to="/clients" className="hover:text-[#FF5B00] transition-colors block w-fit">Kundecaser</Link></li>
                    <li><Link to="/pricing" className="hover:text-[#FF5B00] transition-colors block w-fit">Priser</Link></li>
                    <li><Link to="/about" className="hover:text-[#FF5B00] transition-colors block w-fit">Om oss</Link></li>
                    {isEmployee === true && (
                      <li><Link to="/ansatt" className="hover:text-[#FF5B00] transition-colors block w-fit text-[#FF5B00]">Ansatt</Link></li>
                    )}
                </ul>
            </div>

            {/* Contact & Hours */}
            <div>
                <h4 className="text-white font-medium mb-6 text-lg">Kontakt oss</h4>
                <div className="space-y-6 text-gray-400 text-sm">
                    <div className="space-y-2">
                        <p className="text-white font-medium">Åpningstider</p>
                        <p>Man: 16:00 – 19:00</p>
                        <p>Tir - Fre: 14:00 – 20:30</p>
                        <p>Lør - Søn: 08:00 – 20:30</p>
                    </div>
                    <div className="space-y-2">
                        <p className="text-white font-medium">Ta kontakt</p>
                        <div className="flex items-center gap-2">
                          <Mail size={14} className="text-[#FF5B00]" />
                          <a href="mailto:kontakt@asoldi.com" className="hover:text-[#FF5B00] transition-colors">kontakt@asoldi.com</a>
                        </div>
                        <div className="flex items-center gap-2">
                          <Phone size={14} className="text-[#FF5B00]" />
                          <a href="tel:+4748339191" className="hover:text-[#FF5B00] transition-colors">+47 48 33 91 91</a>
                        </div>
                    </div>
                </div>
            </div>

            {/* Socials */}
            <div>
                <h4 className="text-white font-medium mb-6 text-lg">Følg oss</h4>
                <div className="flex gap-4">
                    <a href="https://www.facebook.com/people/Asoldi-markedsf%C3%B8ring/61568284364048/" target="_blank" rel="noreferrer" className="w-10 h-10 rounded-full bg-[#1a1a1a] border border-white/10 flex items-center justify-center text-gray-400 hover:bg-[#FF5B00] hover:text-white transition-all duration-300 group">
                        <Facebook size={18} className="group-hover:scale-110 transition-transform" />
                    </a>
                    <a href="https://www.instagram.com/asoldimedia/" target="_blank" rel="noreferrer" className="w-10 h-10 rounded-full bg-[#1a1a1a] border border-white/10 flex items-center justify-center text-gray-400 hover:bg-[#FF5B00] hover:text-white transition-all duration-300 group">
                        <Instagram size={18} className="group-hover:scale-110 transition-transform" />
                    </a>
                    <a href="https://www.youtube.com/@AsoldiMedia?app=desktop" target="_blank" rel="noreferrer" className="w-10 h-10 rounded-full bg-[#1a1a1a] border border-white/10 flex items-center justify-center text-gray-400 hover:bg-[#FF5B00] hover:text-white transition-all duration-300 group">
                        <Youtube size={18} className="group-hover:scale-110 transition-transform" />
                    </a>
                </div>
            </div>

             {/* Legal */}
            <div>
                <h4 className="text-white font-medium mb-6 text-lg">Juridisk</h4>
                <ul className="space-y-4 text-gray-400 text-sm">
                    <li><Link to="/personvern" className="hover:text-[#FF5B00] transition-colors block w-fit">Personvern</Link></li>
                    <li><Link to="/vilkar" className="hover:text-[#FF5B00] transition-colors block w-fit">Vilkår for bruk</Link></li>
                    <li><Link to="/databehandleravtale" className="hover:text-[#FF5B00] transition-colors block w-fit">Databehandleravtale</Link></li>
                    <li><Link to="/informasjonskapsler" className="hover:text-[#FF5B00] transition-colors block w-fit">Informasjonskapsler</Link></li>
                </ul>
            </div>
        </div>

        {/* Bottom Bar */}
        <div className="flex flex-col md:flex-row justify-between items-center pt-8 border-t border-white/5 text-gray-500 text-sm">
          <div className="mb-4 md:mb-0">
            © {currentYear} Asoldi Markedsføring. Alle rettigheter reservert.
          </div>
          <div className="flex gap-6">
             <span className="hover:text-white cursor-pointer transition-colors">Digital vekst for din bedrift</span>
          </div>
        </div>
      </div>
    </footer>
  );
};
