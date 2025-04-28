const puppeteer = require('puppeteer');
const fs = require('fs');
const csv = require('csv-parser');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

const inputFile = 'input.csv';
const outputFile = 'output.csv';

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseFullAddress(fullAddress) {
    // S'assurer que l'adresse est une chaîne
    if (!fullAddress || typeof fullAddress !== 'string') {
        console.log('Adresse invalide:', fullAddress);
        return {
            Adresse: '',
            'Code postal': '',
            Ville: ''
        };
    }
    
    // Format standard français: "numéro rue, code postal ville"
    // Pattern plus strict pour isoler clairement le code postal et la ville
    const standardPattern = /^(.*?),?\s*(\d{5})\s+([A-Za-zÀ-ÿ\s\-]+)(?:\.|$)/;
    const match = fullAddress.match(standardPattern);
    
    if (match) {
        return {
            Adresse: match[1].trim(),
            'Code postal': match[2],
            Ville: match[3].trim().split('.')[0].split(' - ')[0] // Enlève les points et textes après "-"
        };
    }
    
    // Si le pattern standard ne fonctionne pas, cherchons le code postal et divisons l'adresse
    const postalCodeMatch = fullAddress.match(/\b(\d{5})\b/);
    if (postalCodeMatch) {
        const postalCode = postalCodeMatch[1];
        const parts = fullAddress.split(postalCode);
        
        // La partie avant le code postal est l'adresse
        let adresse = parts[0].trim().replace(/,$/, '');
        
        // La ville est généralement le premier mot après le code postal
        let ville = '';
        if (parts[1]) {
            // Prendre le premier mot qui ressemble à une ville (lettres et tirets seulement)
            const villeMatch = parts[1].trim().match(/^([A-Za-zÀ-ÿ\-]+)/);
            if (villeMatch) {
                ville = villeMatch[1].trim();
            }
        }
        
        return {
            Adresse: adresse,
            'Code postal': postalCode,
            Ville: ville
        };
    }

    console.log('Impossible de parser l\'adresse:', fullAddress);
    return {
        Adresse: '',
        'Code postal': '',
        Ville: ''
    };
}

// Fonction avancée pour les cas plus complexes
function parseFullAddressAdvanced(fullAddress) {
    // S'assurer que l'adresse est une chaîne
    if (!fullAddress || typeof fullAddress !== 'string') {
        return {
            Adresse: '',
            'Code postal': '',
            Ville: ''
        };
    }
    
    // Nettoyage préliminaire - enlever les informations supplémentaires communes
    let cleanedAddress = fullAddress
        .replace(/\d{2}\s\d{2}\s\d{2}\s\d{2}\s\d{2}/g, '') // Supprime les numéros de téléphone
        .replace(/Être rappelé\(e\).*$/i, '') // Supprime "Être rappelé(e) par le centre"
        .replace(/Demande rapide.*$/i, '') // Supprime "Demande rapide sans engagement"
        .replace(/Mentions légales.*$/i, '') // Supprime mentions légales et suite
        .replace(/To navigate.*$/i, '') // Supprime instructions de navigation
        .replace(/Comptes annuels.*$/i, '') // Supprime mentions comptables
        .replace(/ACCESSIBLE.*$/i, '') // Supprime horaires d'accessibilité
        .replace(/\s-\s.*$/g, '') // Supprime tout ce qui suit un tiret avec espaces
        .trim();
    
    // Format standard: "numéro rue, code postal ville"
    const standardPattern = /^(.*?)[,\s]*(\d{5})\s+([A-Za-zÀ-ÿ\s\-]+)(?:\.|$)/;
    const match = cleanedAddress.match(standardPattern);
    
    if (match) {
        // Extraire uniquement le nom de la ville (premier mot après le code postal)
        const villeComplete = match[3].trim();
        const villePrincipale = villeComplete.split(/[\s\.-]/)[0];
        
        return {
            Adresse: match[1].trim(),
            'Code postal': match[2],
            Ville: villePrincipale
        };
    }
    
    // Approche de repli - chercher juste le code postal
    const postalCodeMatch = cleanedAddress.match(/\b(\d{5})\b/);
    if (postalCodeMatch) {
        const postalCode = postalCodeMatch[1];
        const postalIndex = cleanedAddress.indexOf(postalCode);
        
        // Tout avant le code postal est considéré comme l'adresse
        const adresse = cleanedAddress.substring(0, postalIndex).trim().replace(/,$/, '');
        
        // Chercher un nom de ville après le code postal
        const afterPostal = cleanedAddress.substring(postalIndex + 5);
        const villeMatch = afterPostal.match(/^\s+([A-Za-zÀ-ÿ\-]+)/);
        let ville = '';
        
        if (villeMatch) {
            ville = villeMatch[1].trim();
        }
        
        return {
            Adresse: adresse,
            'Code postal': postalCode,
            Ville: ville
        };
    }
    
    return {
        Adresse: '',
        'Code postal': '',
        Ville: ''
    };
}

// Cette fonction peut être utilisée dans le processus principal pour traiter l'adresse
function processAddress(fullAddress) {
    // Essayer d'abord avec la méthode standard
    const result = parseFullAddress(fullAddress);
    
    // Si la ville n'est pas extraite correctement, essayer la méthode avancée
    if (!result.Ville && fullAddress) {
        console.log('Méthode standard échouée, essai avec méthode avancée...');
        return parseFullAddressAdvanced(fullAddress);
    }
    
    return result;
}

async function getAddressFromGoogle(query, page) {
    try {
        await page.goto(`https://www.google.com/search?q=${encodeURIComponent(query)}`, {
            waitUntil: 'networkidle2', // Attendre que le réseau soit inactif
        });
        
        // Attendre un peu plus longtemps pour que tout se charge
        await delay(3000);

        // Simuler un scroll pour s'assurer que tout est bien chargé
        await page.evaluate(() => {
            window.scrollBy(0, 300);
        });

        const fullAddress = await page.evaluate(() => {
            // Essai 1: Chercher dans le Knowledge Panel (nouvelle structure)
            const addressElements = Array.from(document.querySelectorAll('span[role="text"]'));
            for (const el of addressElements) {
                // Recherche de motifs d'adresse française (avec code postal à 5 chiffres)
                if (/\d+.*\d{5}\s+\w+/.test(el.innerText)) {
                    return el.innerText;
                }
            }
            
            // Essai 2: Chercher dans la nouvelle structure de Knowledge Panel
            const infoRows = Array.from(document.querySelectorAll('div.osrp-blk'));
            for (const row of infoRows) {
                if (row.innerText.includes('Adresse') || row.innerText.includes('adresse')) {
                    const addressText = row.innerText.split('\n').slice(1).join(' ');
                    if (addressText && /\d{5}/.test(addressText)) {
                        return addressText;
                    }
                }
            }
            
            // Essai 3: Chercher dans d'autres éléments contenant "Adresse"
            const addressSections = Array.from(document.querySelectorAll('div'));
            for (const section of addressSections) {
                if (section.innerText.includes('Adresse :') || section.innerText.includes('Adresse')) {
                    const lines = section.innerText.split('\n');
                    for (const line of lines) {
                        if (/\d+.*\d{5}\s+\w+/.test(line)) {
                            return line;
                        }
                    }
                }
            }
            
            // Essai 4: Parcourir tous les snippets de résultats
            const snippets = Array.from(document.querySelectorAll('div, span, li'));
            for (const s of snippets) {
                // Recherche d'un format d'adresse française typique
                if (s.innerText && /\d+\s+[\w\s,\.]+\d{5}\s+[\w\s\-]+/i.test(s.innerText)) {
                    return s.innerText.match(/\d+\s+[\w\s,\.]+\d{5}\s+[\w\s\-]+/i)[0];
                }
            }
            
            return '';
        });

        console.log('Adresse brute trouvée:', fullAddress);
        return fullAddress;
    } catch (err) {
        console.error('Erreur lors de la récupération de l\'adresse :', err);
        return '';
    }
}

// Fonction pour extraire numéro et voie d'une adresse
function extractStreetAddressOnly(address) {
    if (!address) return '';
    
    // Essayer de récupérer juste le numéro et la voie
    const match = address.match(/^(\d+[\s,].*?)(?=\d{5}|\s*$)/i);
    if (match) {
        return match[1].trim();
    }
    return address; // Retourner l'adresse d'origine si extraction impossible
}

(async () => {
    const browser = await puppeteer.launch({
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled'
        ]
    });
    const page = await browser.newPage();

    // Masquer les traces d'automatisation
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        delete navigator.webdriver;
        window.navigator.chrome = { runtime: {} };
    });

    const rows = [];
    const results = [];

    fs.createReadStream(inputFile)
        .pipe(csv())
        .on('data', (data) => rows.push(data))
        .on('end', async () => {
            console.log(`📊 Traitement de ${rows.length} lignes...`);
            
            for (let [index, row] of rows.entries()) {
                // Première tentative: recherche avec nom de l'établissement + adresse
                let query = `${row["Nom établissement"]} ${row["Adresse"] || ""} ${row["Ville"] || ""}`;
                console.log(`🔍 Recherche ${index + 1}/${rows.length} (1/2): ${query}`);

                let fullAddress = await getAddressFromGoogle(query, page);
                
                // Si pas de résultat, faire une deuxième tentative avec uniquement numéro et voie
                if (!fullAddress && row["Adresse"]) {
                    const streetAddressOnly = extractStreetAddressOnly(row["Adresse"]);
                    if (streetAddressOnly) {
                        // Délai avant la deuxième requête
                        const delayMs = 3000 + Math.random() * 2000;
                        await delay(delayMs);
                        
                        // Deuxième tentative: recherche avec seulement numéro et voie + ville si disponible
                        query = `${streetAddressOnly} ${row["Ville"] || ""}`;
                        console.log(`🔍 Recherche ${index + 1}/${rows.length} (2/2): ${query}`);
                        
                        fullAddress = await getAddressFromGoogle(query, page);
                    }
                }
                
                if (fullAddress) {
                    console.log(`📬 Adresse trouvée : ${fullAddress}`);
                    // Utiliser la nouvelle fonction de traitement d'adresse
                    const parsed = processAddress(fullAddress);
                    
                    results.push({
                        ...row,
                        Adresse: parsed.Adresse || row.Adresse,
                        'Code postal': parsed['Code postal'] || row['Code postal'] || '',
                        Ville: parsed.Ville || row.Ville || ''
                    });
                    
                    console.log(`✅ Résultat parsé : ${parsed.Adresse}, ${parsed['Code postal']} ${parsed.Ville}`);
                } else {
                    console.log(`❌ Aucune adresse trouvée pour ${row["Nom établissement"]}`);
                    results.push({...row});
                }

                // Délai variable entre les requêtes pour éviter la détection de bot
                const delayMs = 5000 + Math.random() * 3000;
                console.log(`⏳ Pause de ${Math.round(delayMs/1000)} secondes...`);
                await delay(delayMs);
            }

            const csvWriter = createCsvWriter({
                path: outputFile,
                header: Object.keys(results[0] || {}).map(id => ({ id, title: id }))
            });

            await csvWriter.writeRecords(results);
            console.log('✅ Fichier output.csv généré avec les adresses complètes !');

            await browser.close();
        });
})();