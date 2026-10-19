import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Button } from './Button';
import { Menu, X, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useEmployeeAuth } from '../contexts/EmployeeAuthContext';
import { useClientAuth } from '../contexts/ClientAuthContext';
import { BOOKER_PATH } from '../pages/ansatt/path';

export const Navbar = () => {
  const { isEmployee } = useEmployeeAuth();
  const { isClient } = useClientAuth();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isServicesOpen, setIsServicesOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const navLinks = [
    { name: 'Priser', href: '/pricing' },
    { name: 'Om oss', href: '/about' },
    { name: 'Kundecaser', href: '/clients' },
  ];

  const services = [
    { name: "Nettsideutvikling", href: "/services/web-development" },
    { name: "Sosiale Medier Marketing", href: "/services/social-media" },
    { name: "Innholdsproduksjon", href: "/services/photo-video" },
    { name: "E-post Markedsføring", href: "/services/email-marketing" }
  ];

  return (
    <nav 
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        isScrolled ? 'bg-[#050505]/80 backdrop-blur-md py-4' : 'bg-transparent py-6'
      }`}
    >
      <div className="max-w-[1440px] mx-auto px-5 md:px-8 flex items-center justify-between">
        <Link to="/" className="flex-shrink-0 z-50 flex items-center py-1">
          <img src="/media/Untitled-1.png" alt="Asoldi" className="h-9 md:h-10 w-auto" />
        </Link>

        {/* Desktop Menu */}
        <div className="hidden lg:flex items-center gap-8 bg-[#1a1a1a]/50 backdrop-blur-sm px-8 py-3 rounded-full border border-white/5">
          <Link to="/pricing" className="text-sm font-medium text-gray-300 hover:text-[#FF5B00] transition-colors">
            Priser
          </Link>
          <Link to="/about" className="text-sm font-medium text-gray-300 hover:text-[#FF5B00] transition-colors">
            Om oss
          </Link>
          
          {/* Services Dropdown */}
          <div 
            className="relative group"
            onMouseEnter={() => setIsServicesOpen(true)}
            onMouseLeave={() => setIsServicesOpen(false)}
          >
            <div className="flex items-center gap-1 text-sm font-medium text-gray-300 hover:text-[#FF5B00] transition-colors py-2 cursor-default">
              Tjenester <ChevronDown size={14} className={`transition-transform duration-200 ${isServicesOpen ? 'rotate-180' : ''}`} />
            </div>
            
            <AnimatePresence>
              {isServicesOpen && (
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 10 }}
                  transition={{ duration: 0.2 }}
                  className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 bg-[#121212] border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
                >
                  <div className="py-2">
                    {services.map((service) => (
                      <Link
                        key={service.name}
                        to={service.href}
                        className="block px-4 py-3 text-sm text-gray-300 hover:text-[#FF5B00] hover:bg-white/5 transition-colors"
                      >
                        {service.name}
                      </Link>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <Link to="/clients" className="text-sm font-medium text-gray-300 hover:text-[#FF5B00] transition-colors">
            Kundecaser
          </Link>
          {isEmployee === true && (
            <Link to={BOOKER_PATH} className="text-sm font-medium text-[#FF5B00] hover:text-[#ff7b2e] transition-colors">
              Møte booker
            </Link>
          )}
        </div>

        <div className="hidden lg:flex items-center gap-4">
          {isClient ? (
            <Link to="/kunde/hjem" className="text-sm font-medium text-gray-300 hover:text-[#FF5B00] transition-colors">
              Kundeportal
            </Link>
          ) : isEmployee !== true ? (
            <Link to="/login" className="text-sm font-medium text-gray-300 hover:text-[#FF5B00] transition-colors">
              Login
            </Link>
          ) : null}
          <Link to="/booking" className="bg-[#FF5B00] text-white px-6 py-3 rounded-full font-medium hover:bg-white hover:text-black transition-colors">
            Book konsultasjon
          </Link>
        </div>

        {/* Mobile Menu Toggle - z-[60] so it stays above overlay when menu is open */}
        <button 
          className="lg:hidden z-[60] p-2.5 text-white relative flex-shrink-0 ml-2"
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
        >
          {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>

        {/* Mobile Menu Overlay - pointer-events-none on bg so burger button stays clickable */}
        <AnimatePresence>
          {isMobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="fixed inset-0 bg-[#050505] z-40 flex flex-col items-center justify-center gap-8 lg:hidden pt-20 overflow-y-auto pointer-events-none"
            >
              <div className="pointer-events-auto flex flex-col items-center gap-8">
              <Link to="/pricing" className="text-2xl font-medium text-white" onClick={() => setIsMobileMenuOpen(false)}>Priser</Link>
              <Link to="/about" className="text-2xl font-medium text-white" onClick={() => setIsMobileMenuOpen(false)}>Om oss</Link>
              
              <div className="flex flex-col items-center gap-4">
                <span className="text-2xl font-medium text-white cursor-default">Tjenester</span>
                <div className="flex flex-col items-center gap-3">
                  {services.map((service) => (
                    <Link
                      key={service.name}
                      to={service.href}
                      className="text-lg text-gray-400 hover:text-[#FF5B00]"
                      onClick={() => setIsMobileMenuOpen(false)}
                    >
                      {service.name}
                    </Link>
                  ))}
                </div>
              </div>

              <Link to="/clients" className="text-2xl font-medium text-white" onClick={() => setIsMobileMenuOpen(false)}>Kundecaser</Link>
              {isEmployee === true && (
                <Link to={BOOKER_PATH} className="text-2xl font-medium text-[#FF5B00]" onClick={() => setIsMobileMenuOpen(false)}>Møte booker</Link>
              )}
              {isClient ? (
                <Link to="/kunde/hjem" className="text-xl font-medium text-white" onClick={() => setIsMobileMenuOpen(false)}>Kundeportal</Link>
              ) : isEmployee !== true ? (
                <Link to="/login" className="text-xl font-medium text-white" onClick={() => setIsMobileMenuOpen(false)}>Login</Link>
              ) : null}
              <Link to="/booking" className="bg-[#FF5B00] text-white px-8 py-4 rounded-full font-medium text-xl mt-4" onClick={() => setIsMobileMenuOpen(false)}>
                Book konsultasjon
              </Link>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </nav>
  );
};
