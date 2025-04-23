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
    // Cette regex a été améliorée pour gérer plus de formats d'adresses français
    const regex = /^([\d\s\w\-\'.,éèàêâçÉÈÀÂÎôûù]*)\s*,?\s*(\d{5})\s+([\w\-\séèàêâçÉÈÀÂÎôûù]+)$/i;
    const match = fullAddress.match(regex);

    if (match) {
        return {
            Adresse: match[1].trim(),
            'Code postal': match[2],
            Ville: match[3].trim()
        };
    }
    
    // Si la première regex échoue, essayons une approche plus souple
    const postalCodeMatch = fullAddress.match(/\b(\d{5})\b/);
    if (postalCodeMatch) {
        const postalCode = postalCodeMatch[1];
        const parts = fullAddress.split(postalCode);
        
        // Essayons d'extraire la ville après le code postal
        let ville = '';
        if (parts[1]) {
            ville = parts[1].trim().split(',')[0].trim();
        }
        
        return {
            Adresse: parts[0].trim().replace(/,$/, ''),
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
                const query = `${row["Nom établissement"]} ${row["Adresse"] || ""} ${row["Ville"] || ""}`;
                console.log(`🔍 Recherche ${index + 1}/${rows.length} : ${query}`);

                const fullAddress = await getAddressFromGoogle(query, page);
                
                if (fullAddress) {
                    console.log(`📬 Adresse trouvée : ${fullAddress}`);
                    const parsed = parseFullAddress(fullAddress);
                    
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