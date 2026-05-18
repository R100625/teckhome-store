import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { CATEGORIES, type Product } from './types'
import { getProducts, getAllProducts, saveProduct, deleteProduct, toggleFeatured } from './storage'

type Bindings = {
  PRODUCTS_KV: KVNamespace
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors())

// Helper para KV
function getKV(c: any): KVNamespace | null {
  try {
    return c.env?.PRODUCTS_KV || null
  } catch {
    return null
  }
}

// === API ROUTES ===

// Listar categorias
app.get('/api/categories', (c) => {
  return c.json(CATEGORIES)
})

// Listar produtos de uma categoria
app.get('/api/products/:categoryId', async (c) => {
  const { categoryId } = c.req.param()
  const kv = getKV(c)
  const products = await getProducts(kv, categoryId)
  return c.json(products)
})

// Listar todos os produtos
app.get('/api/products', async (c) => {
  const kv = getKV(c)
  const products = await getAllProducts(kv)
  return c.json(products)
})

// Buscar metadados de URL (Open Graph scraping)
app.post('/api/fetch-metadata', async (c) => {
  try {
    const { url } = await c.req.json()
    if (!url) return c.json({ error: 'URL obrigatória' }, 400)

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TeckhomeBot/1.0)',
        'Accept': 'text/html'
      },
      redirect: 'follow'
    })

    const html = await response.text()

    const getMetaContent = (property: string): string => {
      const patterns = [
        new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, 'i'),
        new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${property}["']`, 'i'),
      ]
      for (const re of patterns) {
        const m = html.match(re)
        if (m) return m[1].trim()
      }
      return ''
    }

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    const title = getMetaContent('og:title') || getMetaContent('twitter:title') || (titleMatch ? titleMatch[1].trim() : '') || 'Produto'
    const description = getMetaContent('og:description') || getMetaContent('description') || ''
    const imageUrl = getMetaContent('og:image') || getMetaContent('twitter:image') || ''

    // Tenta extrair preço
    const pricePatterns = [
      /R\$\s*[\d.,]+/gi,
      /"price":\s*"?([\d.,]+)"?/i,
      /data-price=["']([\d.,]+)["']/i
    ]
    let price = ''
    for (const pattern of pricePatterns) {
      const m = html.match(pattern)
      if (m) {
        price = m[0].replace(/"price":\s*"?/, 'R$ ').replace(/"?$/, '')
        break
      }
    }

    // Detecta loja
    const hostname = new URL(url).hostname.replace('www.', '')
    const storeMap: Record<string, string> = {
      'amazon.com.br': 'Amazon',
      'mercadolivre.com.br': 'Mercado Livre',
      'shopee.com.br': 'Shopee',
      'americanas.com.br': 'Americanas',
      'magazineluiza.com.br': 'Magazine Luiza',
      'casasbahia.com.br': 'Casas Bahia',
      'pontofrio.com.br': 'Ponto Frio',
      'extra.com.br': 'Extra',
      'submarino.com.br': 'Submarino',
      'kabum.com.br': 'KaBuM',
      'fastshop.com.br': 'FastShop',
      'aliexpress.com': 'AliExpress'
    }
    const store = storeMap[hostname] || hostname

    return c.json({ title, description, imageUrl, price, store, url })
  } catch (e) {
    return c.json({ error: 'Falha ao buscar metadados', title: '', description: '', imageUrl: '', price: '', store: '' }, 200)
  }
})

// Adicionar produto
app.post('/api/products', async (c) => {
  try {
    const body = await c.req.json()
    const { categoryId, title, description, imageUrl, productUrl, price, store } = body

    if (!categoryId || !productUrl) {
      return c.json({ error: 'categoryId e productUrl são obrigatórios' }, 400)
    }

    const cat = CATEGORIES.find(c => c.id === categoryId)
    if (!cat) return c.json({ error: 'Categoria inválida' }, 400)

    const product: Product = {
      id: `prod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      categoryId,
      title: title || 'Produto sem título',
      description: description || '',
      imageUrl: imageUrl || '',
      productUrl,
      price: price || '',
      store: store || '',
      rating: body.rating || 0,
      featured: false,
      createdAt: new Date().toISOString()
    }

    const kv = getKV(c)
    await saveProduct(kv, product)

    return c.json({ success: true, product }, 201)
  } catch (e) {
    return c.json({ error: 'Erro ao salvar produto' }, 500)
  }
})

// Atualizar produto
app.put('/api/products/:categoryId/:productId', async (c) => {
  try {
    const { categoryId, productId } = c.req.param()
    const body = await c.req.json()
    const kv = getKV(c)

    const products = await getProducts(kv, categoryId)
    const product = products.find(p => p.id === productId)
    if (!product) return c.json({ error: 'Produto não encontrado' }, 404)

    const updated = { ...product, ...body, id: productId, categoryId }
    await saveProduct(kv, updated)

    return c.json({ success: true, product: updated })
  } catch (e) {
    return c.json({ error: 'Erro ao atualizar produto' }, 500)
  }
})

// Deletar produto
app.delete('/api/products/:categoryId/:productId', async (c) => {
  const { categoryId, productId } = c.req.param()
  const kv = getKV(c)
  const ok = await deleteProduct(kv, categoryId, productId)

  if (!ok) return c.json({ error: 'Produto não encontrado' }, 404)
  return c.json({ success: true })
})

// Toggle destaque
app.patch('/api/products/:categoryId/:productId/featured', async (c) => {
  const { categoryId, productId } = c.req.param()
  const kv = getKV(c)
  const product = await toggleFeatured(kv, categoryId, productId)
  if (!product) return c.json({ error: 'Produto não encontrado' }, 404)
  return c.json({ success: true, product })
})

// === PÁGINA PRINCIPAL ===
app.get('/', (c) => {
  return c.html(homePage())
})

// === PÁGINA DE CATEGORIA ===
app.get('/categoria/:id', (c) => {
  const { id } = c.req.param()
  const cat = CATEGORIES.find(cat => cat.id === id)
  if (!cat) return c.redirect('/')
  return c.html(categoryPage(cat.id))
})

// === PAINEL ADMIN ===
app.get('/admin', (c) => {
  return c.html(adminPage())
})

// === HTML PAGES ===

function homePage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TeckHome Store - Reviews de Produtos</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .gradient-hero { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 30%, #1e3a5f 70%, #0f172a 100%); }
    .card-hover { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    .card-hover:hover { transform: translateY(-8px); box-shadow: 0 25px 50px rgba(0,0,0,0.15); }
    .shimmer { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    .featured-badge { background: linear-gradient(135deg, #f59e0b, #ef4444); }
    .category-card:hover .category-icon { transform: scale(1.2) rotate(5deg); }
    .category-icon { transition: transform 0.3s ease; display: inline-block; }
    .search-box:focus { box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.3); }
    .pulse-dot { animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #f1f1f1; }
    ::-webkit-scrollbar-thumb { background: #6366f1; border-radius: 4px; }
    .nav-link { position: relative; }
    .nav-link::after { content: ''; position: absolute; bottom: -2px; left: 0; width: 0; height: 2px; background: #6366f1; transition: width 0.3s; }
    .nav-link:hover::after { width: 100%; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

  <!-- NAVBAR -->
  <nav class="bg-white shadow-sm sticky top-0 z-50 border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-3">
          <div class="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
            <i class="fas fa-bolt text-white text-sm"></i>
          </div>
          <div>
            <span class="text-xl font-black text-gray-900">Teck<span class="text-indigo-600">Home</span></span>
            <span class="text-xs text-gray-400 block leading-none -mt-0.5">Store Reviews</span>
          </div>
        </a>
        <div class="hidden md:flex items-center gap-6">
          <a href="/" class="nav-link text-sm font-medium text-gray-700 hover:text-indigo-600 transition-colors">Início</a>
          <a href="#categorias" class="nav-link text-sm font-medium text-gray-700 hover:text-indigo-600 transition-colors">Categorias</a>
          <a href="#destaques" class="nav-link text-sm font-medium text-gray-700 hover:text-indigo-600 transition-colors">Destaques</a>
          <a href="/admin" class="bg-indigo-600 text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-indigo-700 transition-colors flex items-center gap-2">
            <i class="fas fa-plus text-xs"></i> Adicionar Produto
          </a>
        </div>
        <button id="mobileMenuBtn" class="md:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100">
          <i class="fas fa-bars"></i>
        </button>
      </div>
    </div>
    <!-- Mobile menu -->
    <div id="mobileMenu" class="hidden md:hidden border-t border-gray-100 bg-white px-4 pb-4">
      <div class="flex flex-col gap-3 pt-3">
        <a href="/" class="text-sm font-medium text-gray-700 py-2">Início</a>
        <a href="#categorias" class="text-sm font-medium text-gray-700 py-2">Categorias</a>
        <a href="#destaques" class="text-sm font-medium text-gray-700 py-2">Destaques</a>
        <a href="/admin" class="bg-indigo-600 text-white text-sm font-medium px-4 py-2 rounded-xl text-center">+ Adicionar Produto</a>
      </div>
    </div>
  </nav>

  <!-- HERO -->
  <section class="gradient-hero text-white py-20 px-4 relative overflow-hidden">
    <div class="absolute inset-0 overflow-hidden">
      <div class="absolute -top-20 -right-20 w-80 h-80 bg-indigo-500 rounded-full opacity-10 blur-3xl"></div>
      <div class="absolute -bottom-20 -left-20 w-80 h-80 bg-blue-500 rounded-full opacity-10 blur-3xl"></div>
    </div>
    <div class="max-w-4xl mx-auto text-center relative z-10">
      <div class="inline-flex items-center gap-2 bg-white/10 backdrop-blur-sm rounded-full px-4 py-2 text-sm mb-6 border border-white/20">
        <span class="pulse-dot w-2 h-2 bg-green-400 rounded-full"></span>
        <span>Reviews e recomendações atualizadas</span>
      </div>
      <h1 class="text-4xl md:text-6xl font-black mb-6 leading-tight">
        Os melhores produtos<br>
        <span class="text-indigo-300">para sua casa</span>
      </h1>
      <p class="text-lg md:text-xl text-indigo-100 mb-8 max-w-2xl mx-auto">
        Encontre os melhores produtos de tecnologia, eletrodomésticos e muito mais com reviews honestos e links diretos para compra.
      </p>
      <!-- Barra de busca -->
      <div class="max-w-lg mx-auto relative">
        <input 
          id="searchInput"
          type="text" 
          placeholder="Buscar produtos..." 
          class="search-box w-full py-4 px-6 pr-14 rounded-2xl text-gray-800 text-sm font-medium bg-white shadow-2xl outline-none border-2 border-transparent focus:border-indigo-300"
          oninput="handleSearch(this.value)"
        >
        <button class="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center hover:bg-indigo-700 transition-colors">
          <i class="fas fa-search text-white text-sm"></i>
        </button>
      </div>
    </div>
  </section>

  <!-- SEARCH RESULTS -->
  <div id="searchResults" class="hidden max-w-7xl mx-auto px-4 py-8">
    <h2 class="text-xl font-bold text-gray-800 mb-4">Resultados da busca</h2>
    <div id="searchGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6"></div>
    <div id="noResults" class="hidden text-center py-16 text-gray-400">
      <i class="fas fa-search text-5xl mb-4 opacity-30"></i>
      <p class="text-lg font-medium">Nenhum produto encontrado</p>
    </div>
  </div>

  <!-- CATEGORIAS -->
  <section id="categorias" class="max-w-7xl mx-auto px-4 py-16">
    <div class="text-center mb-12">
      <h2 class="text-3xl font-black text-gray-900 mb-3">Explore por Categoria</h2>
      <p class="text-gray-500 text-lg">Encontre exatamente o que você precisa</p>
    </div>
    <div id="categoriesGrid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
      <div class="shimmer rounded-2xl h-36"></div>
    </div>
  </section>

  <!-- DESTAQUES -->
  <section id="destaques" class="bg-white py-16 px-4">
    <div class="max-w-7xl mx-auto">
      <div class="flex items-center justify-between mb-10">
        <div>
          <h2 class="text-3xl font-black text-gray-900 mb-1">Produtos em Destaque</h2>
          <p class="text-gray-500">Os mais recomendados pela nossa equipe</p>
        </div>
        <a href="/admin" class="hidden md:flex items-center gap-2 text-indigo-600 font-semibold hover:text-indigo-800 transition-colors text-sm">
          <i class="fas fa-plus"></i> Adicionar
        </a>
      </div>
      <div id="featuredGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        <div class="shimmer rounded-2xl h-80"></div>
        <div class="shimmer rounded-2xl h-80"></div>
        <div class="shimmer rounded-2xl h-80"></div>
        <div class="shimmer rounded-2xl h-80"></div>
      </div>
      <div id="noFeatured" class="hidden text-center py-16 text-gray-400">
        <i class="fas fa-star text-5xl mb-4 opacity-30"></i>
        <p class="text-lg font-medium mb-2">Nenhum produto em destaque ainda</p>
        <a href="/admin" class="text-indigo-600 font-medium hover:underline">Adicionar produtos agora →</a>
      </div>
    </div>
  </section>

  <!-- RECENTES POR CATEGORIA -->
  <section class="max-w-7xl mx-auto px-4 py-16" id="recentSection">
    <div class="text-center mb-10">
      <h2 class="text-3xl font-black text-gray-900 mb-3">Adicionados Recentemente</h2>
      <p class="text-gray-500">Últimos produtos cadastrados</p>
    </div>
    <div id="recentGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
    </div>
    <div id="noRecent" class="hidden text-center py-16 text-gray-400">
      <i class="fas fa-box-open text-5xl mb-4 opacity-30"></i>
      <p class="text-lg font-medium mb-2">Nenhum produto cadastrado ainda</p>
      <a href="/admin" class="text-indigo-600 font-medium hover:underline">Começar a adicionar produtos →</a>
    </div>
  </section>

  <!-- FOOTER -->
  <footer class="bg-gray-900 text-white py-12 px-4">
    <div class="max-w-7xl mx-auto">
      <div class="flex flex-col md:flex-row justify-between items-center gap-6">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
            <i class="fas fa-bolt text-white"></i>
          </div>
          <div>
            <span class="text-xl font-black">Teck<span class="text-indigo-400">Home</span> Store</span>
            <p class="text-gray-400 text-xs mt-0.5">Reviews e recomendações de produtos</p>
          </div>
        </div>
        <div class="flex gap-6 text-sm text-gray-400">
          <a href="/" class="hover:text-white transition-colors">Início</a>
          <a href="#categorias" class="hover:text-white transition-colors">Categorias</a>
          <a href="/admin" class="hover:text-white transition-colors">Admin</a>
        </div>
        <p class="text-gray-500 text-sm">© 2025 TeckHome Store. Todos os direitos reservados.</p>
      </div>
    </div>
  </footer>

  <script>
    let allProductsCache = []

    // Mobile menu
    document.getElementById('mobileMenuBtn').addEventListener('click', () => {
      document.getElementById('mobileMenu').classList.toggle('hidden')
    })

    function createProductCard(product, category) {
      const stars = product.rating ? '★'.repeat(Math.round(product.rating)) + '☆'.repeat(5 - Math.round(product.rating)) : ''
      const storeIcon = product.store ? \`<span class="text-xs bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-medium">\${product.store}</span>\` : ''
      const featuredBadge = product.featured ? \`<div class="absolute top-3 left-3 featured-badge text-white text-xs font-bold px-2 py-1 rounded-lg flex items-center gap-1"><i class="fas fa-star text-xs"></i> Destaque</div>\` : ''
      const imgSrc = product.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=200\`
      const catColor = category ? category.color : '#6366f1'
      
      return \`
        <div class="card-hover bg-white rounded-2xl overflow-hidden shadow-md border border-gray-100 flex flex-col">
          <div class="relative">
            <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer">
              <div class="h-52 overflow-hidden bg-gray-50">
                <img src="\${imgSrc}" alt="\${product.title}" class="w-full h-full object-cover hover:scale-105 transition-transform duration-300" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=200'">
              </div>
            </a>
            \${featuredBadge}
            \${category ? \`<div class="absolute top-3 right-3 text-2xl">\${category.icon}</div>\` : ''}
          </div>
          <div class="p-4 flex flex-col flex-1 gap-2">
            <div class="flex items-start justify-between gap-2">
              <h3 class="font-bold text-gray-800 text-sm leading-tight line-clamp-2 flex-1">\${product.title}</h3>
            </div>
            \${product.description ? \`<p class="text-gray-500 text-xs line-clamp-2">\${product.description}</p>\` : ''}
            <div class="flex items-center gap-2 mt-auto pt-2">
              \${storeIcon}
              \${stars ? \`<span class="text-yellow-400 text-xs">\${stars}</span>\` : ''}
            </div>
            <div class="flex items-center justify-between gap-2 mt-1">
              \${product.price ? \`<span class="text-lg font-black text-indigo-700">\${product.price}</span>\` : '<span class="text-sm text-gray-400">Ver preço</span>'}
              <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer" 
                class="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-colors">
                Comprar <i class="fas fa-external-link-alt text-xs"></i>
              </a>
            </div>
          </div>
        </div>
      \`
    }

    async function loadCategories() {
      const res = await fetch('/api/categories')
      const categories = await res.json()
      
      const grid = document.getElementById('categoriesGrid')
      grid.innerHTML = categories.map(cat => \`
        <a href="/categoria/\${cat.id}" class="category-card card-hover bg-white rounded-2xl p-6 shadow-md border border-gray-100 flex flex-col items-start gap-3 cursor-pointer group">
          <div class="w-12 h-12 rounded-xl flex items-center justify-center text-2xl" style="background: \${cat.color}20">
            <span class="category-icon">\${cat.icon}</span>
          </div>
          <div>
            <h3 class="font-bold text-gray-800 group-hover:text-indigo-600 transition-colors">\${cat.name}</h3>
            <p class="text-gray-400 text-xs mt-0.5 line-clamp-2">\${cat.description}</p>
          </div>
          <div class="flex items-center gap-1 text-indigo-600 text-xs font-medium mt-auto">
            Ver produtos <i class="fas fa-arrow-right text-xs"></i>
          </div>
        </a>
      \`).join('')

      return categories
    }

    async function loadFeatured(categories) {
      const res = await fetch('/api/products')
      allProductsCache = await res.json()
      const featured = allProductsCache.filter(p => p.featured).slice(0, 8)
      
      const grid = document.getElementById('featuredGrid')
      const noFeatured = document.getElementById('noFeatured')
      
      if (featured.length === 0) {
        grid.innerHTML = ''
        noFeatured.classList.remove('hidden')
        return
      }
      
      const catMap = {}
      categories.forEach(c => catMap[c.id] = c)
      grid.innerHTML = featured.map(p => createProductCard(p, catMap[p.categoryId])).join('')
    }

    async function loadRecent(categories) {
      const catMap = {}
      categories.forEach(c => catMap[c.id] = c)
      
      const recent = [...allProductsCache].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8)
      
      const grid = document.getElementById('recentGrid')
      const noRecent = document.getElementById('noRecent')
      
      if (recent.length === 0) {
        grid.innerHTML = ''
        noRecent.classList.remove('hidden')
        return
      }
      
      grid.innerHTML = recent.map(p => createProductCard(p, catMap[p.categoryId])).join('')
    }

    function handleSearch(query) {
      const searchResults = document.getElementById('searchResults')
      const heroSection = document.getElementById('categorias')
      
      if (!query.trim()) {
        searchResults.classList.add('hidden')
        return
      }
      
      const q = query.toLowerCase()
      const filtered = allProductsCache.filter(p => 
        p.title.toLowerCase().includes(q) || 
        p.description.toLowerCase().includes(q) ||
        (p.store && p.store.toLowerCase().includes(q))
      )
      
      searchResults.classList.remove('hidden')
      
      const grid = document.getElementById('searchGrid')
      const noResults = document.getElementById('noResults')
      
      if (filtered.length === 0) {
        grid.innerHTML = ''
        noResults.classList.remove('hidden')
      } else {
        noResults.classList.add('hidden')
        grid.innerHTML = filtered.slice(0, 12).map(p => createProductCard(p, null)).join('')
      }
    }

    async function init() {
      const categories = await loadCategories()
      await loadFeatured(categories)
      await loadRecent(categories)
    }

    init()
  </script>
</body>
</html>`
}

function categoryPage(categoryId: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TeckHome Store - Categoria</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .card-hover { transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
    .card-hover:hover { transform: translateY(-8px); box-shadow: 0 25px 50px rgba(0,0,0,0.15); }
    .shimmer { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    .featured-badge { background: linear-gradient(135deg, #f59e0b, #ef4444); }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: #f1f1f1; }
    ::-webkit-scrollbar-thumb { background: #6366f1; border-radius: 4px; }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

  <!-- NAVBAR -->
  <nav class="bg-white shadow-sm sticky top-0 z-50 border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-3">
          <div class="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
            <i class="fas fa-bolt text-white text-sm"></i>
          </div>
          <div>
            <span class="text-xl font-black text-gray-900">Teck<span class="text-indigo-600">Home</span></span>
            <span class="text-xs text-gray-400 block leading-none -mt-0.5">Store Reviews</span>
          </div>
        </a>
        <div class="flex items-center gap-4">
          <a href="/" class="text-sm font-medium text-gray-600 hover:text-indigo-600 transition-colors flex items-center gap-1">
            <i class="fas fa-home text-xs"></i> Início
          </a>
          <a href="/admin" class="bg-indigo-600 text-white text-sm font-medium px-4 py-2 rounded-xl hover:bg-indigo-700 transition-colors flex items-center gap-2">
            <i class="fas fa-plus text-xs"></i> Adicionar
          </a>
        </div>
      </div>
    </div>
  </nav>

  <!-- HEADER DA CATEGORIA -->
  <div id="categoryHeader" class="py-12 px-4">
    <div class="max-w-7xl mx-auto">
      <div class="shimmer h-8 w-48 rounded-xl mb-2"></div>
      <div class="shimmer h-5 w-80 rounded-xl"></div>
    </div>
  </div>

  <!-- FILTROS -->
  <div class="max-w-7xl mx-auto px-4 mb-6">
    <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex flex-wrap items-center gap-3">
      <span class="text-sm font-semibold text-gray-700 mr-2">Filtrar:</span>
      <button onclick="filterProducts('all')" id="filter-all" class="filter-btn active-filter text-xs font-medium px-3 py-1.5 rounded-xl border border-indigo-600 bg-indigo-600 text-white transition-all">
        Todos
      </button>
      <button onclick="filterProducts('featured')" id="filter-featured" class="filter-btn text-xs font-medium px-3 py-1.5 rounded-xl border border-gray-200 text-gray-600 hover:border-indigo-400 hover:text-indigo-600 transition-all">
        ⭐ Destaques
      </button>
      <div class="ml-auto">
        <input id="catSearch" type="text" placeholder="Buscar nesta categoria..." 
          class="text-sm px-4 py-2 rounded-xl border border-gray-200 outline-none focus:border-indigo-400 w-52"
          oninput="filterBySearch(this.value)">
      </div>
    </div>
  </div>

  <!-- GRID DE PRODUTOS -->
  <main class="max-w-7xl mx-auto px-4 pb-16">
    <div id="productsGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
      <div class="shimmer rounded-2xl h-80"></div>
    </div>
    <div id="emptyState" class="hidden text-center py-20">
      <div class="text-7xl mb-6 opacity-30" id="emptyIcon">📦</div>
      <h3 class="text-xl font-bold text-gray-600 mb-2">Nenhum produto nesta categoria ainda</h3>
      <p class="text-gray-400 mb-6">Seja o primeiro a adicionar um produto!</p>
      <a href="/admin" class="bg-indigo-600 text-white font-semibold px-6 py-3 rounded-xl hover:bg-indigo-700 transition-colors inline-flex items-center gap-2">
        <i class="fas fa-plus"></i> Adicionar Produto
      </a>
    </div>
  </main>

  <!-- FOOTER -->
  <footer class="bg-gray-900 text-white py-8 px-4 mt-8">
    <div class="max-w-7xl mx-auto flex justify-between items-center flex-wrap gap-4">
      <span class="font-black text-lg">Teck<span class="text-indigo-400">Home</span> Store</span>
      <p class="text-gray-500 text-sm">© 2025 TeckHome Store</p>
    </div>
  </footer>

  <script>
    const CATEGORY_ID = '${categoryId}'
    let allProducts = []
    let category = null
    let currentFilter = 'all'
    let currentSearch = ''

    function createProductCard(product) {
      const stars = product.rating ? '★'.repeat(Math.round(product.rating)) + '☆'.repeat(5 - Math.round(product.rating)) : ''
      const storeIcon = product.store ? \`<span class="text-xs bg-indigo-50 text-indigo-600 px-2 py-0.5 rounded-full font-medium">\${product.store}</span>\` : ''
      const featuredBadge = product.featured ? \`<div class="absolute top-3 left-3 featured-badge text-white text-xs font-bold px-2 py-1 rounded-lg flex items-center gap-1"><i class="fas fa-star text-xs"></i> Destaque</div>\` : ''
      const imgSrc = product.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=200\`
      
      return \`
        <div class="card-hover bg-white rounded-2xl overflow-hidden shadow-md border border-gray-100 flex flex-col" data-id="\${product.id}">
          <div class="relative">
            <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer">
              <div class="h-52 overflow-hidden bg-gray-50">
                <img src="\${imgSrc}" alt="\${product.title}" class="w-full h-full object-cover hover:scale-105 transition-transform duration-300" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(product.title)}&background=6366f1&color=fff&size=200'">
              </div>
            </a>
            \${featuredBadge}
          </div>
          <div class="p-4 flex flex-col flex-1 gap-2">
            <h3 class="font-bold text-gray-800 text-sm leading-tight line-clamp-2">\${product.title}</h3>
            \${product.description ? \`<p class="text-gray-500 text-xs line-clamp-2">\${product.description}</p>\` : ''}
            <div class="flex items-center gap-2">
              \${storeIcon}
              \${stars ? \`<span class="text-yellow-400 text-xs">\${stars}</span>\` : ''}
            </div>
            <div class="flex items-center justify-between gap-2 mt-auto pt-2">
              \${product.price ? \`<span class="text-lg font-black text-indigo-700">\${product.price}</span>\` : '<span class="text-sm text-gray-400">Ver preço</span>'}
              <a href="\${product.productUrl}" target="_blank" rel="noopener noreferrer" 
                class="flex items-center gap-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-colors">
                Comprar <i class="fas fa-external-link-alt text-xs"></i>
              </a>
            </div>
          </div>
        </div>
      \`
    }

    function renderProducts() {
      let filtered = [...allProducts]
      
      if (currentFilter === 'featured') {
        filtered = filtered.filter(p => p.featured)
      }
      
      if (currentSearch) {
        const q = currentSearch.toLowerCase()
        filtered = filtered.filter(p => 
          p.title.toLowerCase().includes(q) || 
          (p.description && p.description.toLowerCase().includes(q))
        )
      }
      
      const grid = document.getElementById('productsGrid')
      const emptyState = document.getElementById('emptyState')
      
      if (filtered.length === 0) {
        grid.innerHTML = ''
        emptyState.classList.remove('hidden')
        if (category) document.getElementById('emptyIcon').textContent = category.icon
      } else {
        emptyState.classList.add('hidden')
        grid.innerHTML = filtered.map(createProductCard).join('')
      }
    }

    function filterProducts(filter) {
      currentFilter = filter
      document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active-filter', 'border-indigo-600', 'bg-indigo-600', 'text-white')
        btn.classList.add('border-gray-200', 'text-gray-600')
      })
      const btn = document.getElementById(\`filter-\${filter}\`)
      btn.classList.add('active-filter', 'border-indigo-600', 'bg-indigo-600', 'text-white')
      btn.classList.remove('border-gray-200', 'text-gray-600')
      renderProducts()
    }

    function filterBySearch(value) {
      currentSearch = value
      renderProducts()
    }

    async function init() {
      // Carregar categoria
      const catRes = await fetch('/api/categories')
      const categories = await catRes.json()
      category = categories.find(c => c.id === CATEGORY_ID)
      
      if (category) {
        document.title = \`TeckHome Store - \${category.name}\`
        document.getElementById('categoryHeader').innerHTML = \`
          <div class="max-w-7xl mx-auto">
            <nav class="text-sm text-gray-400 mb-3 flex items-center gap-2">
              <a href="/" class="hover:text-indigo-600 transition-colors">Início</a>
              <i class="fas fa-chevron-right text-xs"></i>
              <span class="text-gray-600 font-medium">\${category.name}</span>
            </nav>
            <div class="flex items-center gap-4">
              <div class="w-14 h-14 rounded-2xl flex items-center justify-center text-3xl" style="background: \${category.color}20">
                \${category.icon}
              </div>
              <div>
                <h1 class="text-3xl font-black text-gray-900">\${category.name}</h1>
                <p class="text-gray-500">\${category.description}</p>
              </div>
            </div>
          </div>
        \`
      }

      // Carregar produtos
      const prodRes = await fetch(\`/api/products/\${CATEGORY_ID}\`)
      allProducts = await prodRes.json()
      renderProducts()
    }

    init()
  </script>
</body>
</html>`
}

function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TeckHome Store - Admin</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    * { font-family: 'Inter', sans-serif; }
    .shimmer { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; }
    @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    .toast { position: fixed; bottom: 24px; right: 24px; z-index: 9999; transform: translateX(200%); transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1); }
    .toast.show { transform: translateX(0); }
    .card-admin { transition: all 0.2s ease; }
    .card-admin:hover { box-shadow: 0 8px 25px rgba(0,0,0,0.1); }
    .spinner { border: 3px solid #f3f3f3; border-top: 3px solid #6366f1; border-radius: 50%; width: 24px; height: 24px; animation: spin 0.8s linear infinite; display: inline-block; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    .featured-badge { background: linear-gradient(135deg, #f59e0b, #ef4444); }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">

  <!-- Toast -->
  <div id="toast" class="toast">
    <div id="toastInner" class="bg-white rounded-2xl shadow-2xl border px-5 py-4 flex items-center gap-3 min-w-72">
      <i id="toastIcon" class="text-xl"></i>
      <span id="toastMsg" class="font-medium text-gray-800 text-sm"></span>
    </div>
  </div>

  <!-- NAVBAR -->
  <nav class="bg-white shadow-sm sticky top-0 z-50 border-b border-gray-100">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex items-center justify-between h-16">
        <a href="/" class="flex items-center gap-3">
          <div class="w-9 h-9 bg-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
            <i class="fas fa-bolt text-white text-sm"></i>
          </div>
          <div>
            <span class="text-xl font-black text-gray-900">Teck<span class="text-indigo-600">Home</span></span>
            <span class="text-xs text-gray-400 block leading-none -mt-0.5">Painel Admin</span>
          </div>
        </a>
        <div class="flex items-center gap-3">
          <a href="/" class="text-sm font-medium text-gray-600 hover:text-indigo-600 flex items-center gap-1">
            <i class="fas fa-eye text-xs"></i> Ver Site
          </a>
        </div>
      </div>
    </div>
  </nav>

  <div class="max-w-7xl mx-auto px-4 py-8">
    
    <div class="grid lg:grid-cols-5 gap-8">
      
      <!-- FORMULÁRIO DE ADICIONAR -->
      <div class="lg:col-span-2">
        <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sticky top-24">
          <h2 class="text-xl font-black text-gray-900 mb-1 flex items-center gap-2">
            <i class="fas fa-plus-circle text-indigo-600"></i> Adicionar Produto
          </h2>
          <p class="text-gray-400 text-sm mb-6">Cole o link do produto para buscar automaticamente</p>

          <!-- URL Input com auto-fetch -->
          <div class="mb-4">
            <label class="block text-sm font-semibold text-gray-700 mb-2">
              Link do Produto <span class="text-red-500">*</span>
            </label>
            <div class="flex gap-2">
              <input type="url" id="productUrl" placeholder="https://www.amazon.com.br/..." 
                class="flex-1 px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
                onpaste="setTimeout(() => fetchMetadata(), 100)">
              <button onclick="fetchMetadata()" id="fetchBtn"
                class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-3 rounded-xl text-sm font-semibold transition-colors flex items-center gap-2 whitespace-nowrap">
                <i class="fas fa-magic"></i> Buscar
              </button>
            </div>
            <p class="text-xs text-gray-400 mt-1">Cole o link e clique em "Buscar" para preencher automaticamente</p>
          </div>

          <!-- Preview da URL -->
          <div id="urlPreview" class="hidden mb-4 p-3 bg-indigo-50 rounded-xl border border-indigo-100 flex items-center gap-3">
            <img id="previewImg" src="" alt="" class="w-14 h-14 object-cover rounded-lg border border-indigo-200 bg-white">
            <div class="flex-1 min-w-0">
              <p id="previewTitle" class="text-sm font-bold text-gray-800 line-clamp-2"></p>
              <p id="previewStore" class="text-xs text-indigo-600 mt-0.5 font-medium"></p>
              <p id="previewPrice" class="text-sm font-black text-indigo-700 mt-0.5"></p>
            </div>
          </div>

          <!-- Campos do formulário -->
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Categoria <span class="text-red-500">*</span></label>
              <select id="categoryId" class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 bg-white transition-all">
                <option value="">Selecione uma categoria...</option>
              </select>
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Título do Produto <span class="text-red-500">*</span></label>
              <input type="text" id="productTitle" placeholder="Ex: Smart TV Samsung 55' 4K" 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Descrição (opcional)</label>
              <textarea id="productDesc" rows="2" placeholder="Breve descrição do produto..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 resize-none transition-all"></textarea>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Preço (opcional)</label>
                <input type="text" id="productPrice" placeholder="R$ 0,00" 
                  class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
              </div>
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">Loja (opcional)</label>
                <input type="text" id="productStore" placeholder="Amazon, Mercado Livre..." 
                  class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
              </div>
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">URL da Imagem (opcional)</label>
              <input type="url" id="productImage" placeholder="https://..." 
                class="w-full px-4 py-3 rounded-xl border border-gray-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all">
            </div>

            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">Avaliação (0-5)</label>
              <div class="flex items-center gap-3">
                <input type="range" id="productRating" min="0" max="5" step="0.5" value="0" 
                  class="flex-1 accent-indigo-600"
                  oninput="document.getElementById('ratingValue').textContent = this.value + '★'">
                <span id="ratingValue" class="text-yellow-500 font-bold text-sm w-10 text-right">0★</span>
              </div>
            </div>

            <div class="flex items-center gap-3 p-3 bg-yellow-50 rounded-xl border border-yellow-100">
              <input type="checkbox" id="productFeatured" class="w-4 h-4 accent-indigo-600">
              <div>
                <label for="productFeatured" class="text-sm font-semibold text-gray-700 cursor-pointer">
                  ⭐ Marcar como Destaque
                </label>
                <p class="text-xs text-gray-400">Aparece na seção de destaques da página inicial</p>
              </div>
            </div>
          </div>

          <button onclick="addProduct()" id="addBtn"
            class="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 rounded-xl transition-colors flex items-center justify-center gap-2 text-sm">
            <i class="fas fa-plus"></i> Adicionar Produto
          </button>
        </div>
      </div>

      <!-- LISTA DE PRODUTOS -->
      <div class="lg:col-span-3">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-xl font-black text-gray-900 flex items-center gap-2">
            <i class="fas fa-list text-indigo-600"></i> Produtos Cadastrados
          </h2>
          <div class="flex items-center gap-2">
            <select id="filterCategory" onchange="loadProducts()" class="text-sm px-3 py-2 rounded-xl border border-gray-200 outline-none focus:border-indigo-400 bg-white">
              <option value="">Todas as categorias</option>
            </select>
          </div>
        </div>

        <div id="productsList" class="space-y-3">
          <div class="shimmer rounded-2xl h-24"></div>
          <div class="shimmer rounded-2xl h-24"></div>
          <div class="shimmer rounded-2xl h-24"></div>
          <div class="shimmer rounded-2xl h-24"></div>
        </div>

        <div id="emptyAdmin" class="hidden text-center py-16 text-gray-400">
          <i class="fas fa-box-open text-5xl mb-4 opacity-30"></i>
          <p class="text-lg font-medium">Nenhum produto cadastrado ainda</p>
          <p class="text-sm mt-1">Use o formulário ao lado para adicionar produtos</p>
        </div>
      </div>
    </div>
  </div>

  <script>
    let categories = []
    let allProducts = []

    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast')
      const icon = document.getElementById('toastIcon')
      const msg = document.getElementById('toastMsg')
      const inner = document.getElementById('toastInner')
      
      icon.className = type === 'success' ? 'fas fa-check-circle text-green-500 text-xl' : 
                       type === 'error' ? 'fas fa-times-circle text-red-500 text-xl' : 
                       'fas fa-info-circle text-blue-500 text-xl'
      inner.className = \`bg-white rounded-2xl shadow-2xl border px-5 py-4 flex items-center gap-3 min-w-72 \${type === 'success' ? 'border-green-100' : type === 'error' ? 'border-red-100' : 'border-blue-100'}\`
      msg.textContent = message
      toast.classList.add('show')
      setTimeout(() => toast.classList.remove('show'), 3500)
    }

    async function fetchMetadata() {
      const url = document.getElementById('productUrl').value.trim()
      if (!url) return

      const btn = document.getElementById('fetchBtn')
      btn.innerHTML = '<span class="spinner"></span>'
      btn.disabled = true

      try {
        const res = await fetch('/api/fetch-metadata', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url })
        })
        const data = await res.json()

        if (data.title) document.getElementById('productTitle').value = data.title
        if (data.description) document.getElementById('productDesc').value = data.description
        if (data.imageUrl) document.getElementById('productImage').value = data.imageUrl
        if (data.price) document.getElementById('productPrice').value = data.price
        if (data.store) document.getElementById('productStore').value = data.store

        // Preview
        const preview = document.getElementById('urlPreview')
        if (data.title) {
          preview.classList.remove('hidden')
          const imgSrc = data.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(data.title)}&background=6366f1&color=fff&size=100\`
          document.getElementById('previewImg').src = imgSrc
          document.getElementById('previewTitle').textContent = data.title
          document.getElementById('previewStore').textContent = data.store || ''
          document.getElementById('previewPrice').textContent = data.price || ''
          showToast('Metadados carregados com sucesso!', 'success')
        } else {
          showToast('Não foi possível carregar metadados automaticamente. Preencha manualmente.', 'info')
        }
      } catch (e) {
        showToast('Erro ao buscar dados. Preencha os campos manualmente.', 'error')
      }

      btn.innerHTML = '<i class="fas fa-magic"></i> Buscar'
      btn.disabled = false
    }

    async function addProduct() {
      const categoryId = document.getElementById('categoryId').value
      const productUrl = document.getElementById('productUrl').value.trim()
      const title = document.getElementById('productTitle').value.trim()

      if (!categoryId) return showToast('Selecione uma categoria!', 'error')
      if (!productUrl) return showToast('URL do produto é obrigatória!', 'error')
      if (!title) return showToast('Título do produto é obrigatório!', 'error')

      const btn = document.getElementById('addBtn')
      btn.innerHTML = '<span class="spinner"></span> Salvando...'
      btn.disabled = true

      try {
        const res = await fetch('/api/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            categoryId,
            productUrl,
            title,
            description: document.getElementById('productDesc').value.trim(),
            imageUrl: document.getElementById('productImage').value.trim(),
            price: document.getElementById('productPrice').value.trim(),
            store: document.getElementById('productStore').value.trim(),
            rating: parseFloat(document.getElementById('productRating').value),
            featured: document.getElementById('productFeatured').checked
          })
        })

        const data = await res.json()
        if (data.success) {
          showToast('Produto adicionado com sucesso!', 'success')
          resetForm()
          await loadProducts()
        } else {
          showToast(data.error || 'Erro ao adicionar produto', 'error')
        }
      } catch (e) {
        showToast('Erro de conexão', 'error')
      }

      btn.innerHTML = '<i class="fas fa-plus"></i> Adicionar Produto'
      btn.disabled = false
    }

    function resetForm() {
      document.getElementById('productUrl').value = ''
      document.getElementById('categoryId').value = ''
      document.getElementById('productTitle').value = ''
      document.getElementById('productDesc').value = ''
      document.getElementById('productImage').value = ''
      document.getElementById('productPrice').value = ''
      document.getElementById('productStore').value = ''
      document.getElementById('productRating').value = 0
      document.getElementById('ratingValue').textContent = '0★'
      document.getElementById('productFeatured').checked = false
      document.getElementById('urlPreview').classList.add('hidden')
    }

    async function deleteProduct(categoryId, productId, title) {
      if (!confirm(\`Remover "\${title}"?\`)) return
      try {
        const res = await fetch(\`/api/products/\${categoryId}/\${productId}\`, { method: 'DELETE' })
        const data = await res.json()
        if (data.success) {
          showToast('Produto removido!', 'success')
          await loadProducts()
        }
      } catch (e) {
        showToast('Erro ao remover', 'error')
      }
    }

    async function toggleFeatured(categoryId, productId) {
      try {
        const res = await fetch(\`/api/products/\${categoryId}/\${productId}/featured\`, { method: 'PATCH' })
        const data = await res.json()
        if (data.success) {
          showToast(data.product.featured ? '⭐ Marcado como destaque!' : 'Removido dos destaques', 'success')
          await loadProducts()
        }
      } catch (e) {
        showToast('Erro ao alterar destaque', 'error')
      }
    }

    async function loadProducts() {
      const filterCat = document.getElementById('filterCategory').value

      let url = '/api/products'
      if (filterCat) url = \`/api/products/\${filterCat}\`

      const res = await fetch(url)
      allProducts = await res.json()

      const catMap = {}
      categories.forEach(c => catMap[c.id] = c)

      const list = document.getElementById('productsList')
      const empty = document.getElementById('emptyAdmin')

      if (allProducts.length === 0) {
        list.innerHTML = ''
        empty.classList.remove('hidden')
        return
      }

      empty.classList.add('hidden')
      list.innerHTML = allProducts.map(p => {
        const cat = catMap[p.categoryId] || { name: p.categoryId, icon: '📦', color: '#6366f1' }
        const imgSrc = p.imageUrl || \`https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=6366f1&color=fff&size=80\`
        
        return \`
          <div class="card-admin bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex items-center gap-4" data-id="\${p.id}">
            <img src="\${imgSrc}" alt="\${p.title}" class="w-16 h-16 rounded-xl object-cover bg-gray-100 flex-shrink-0" onerror="this.src='https://ui-avatars.com/api/?name=\${encodeURIComponent(p.title)}&background=6366f1&color=fff&size=80'">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-xs px-2 py-0.5 rounded-full font-medium text-white" style="background: \${cat.color}">\${cat.icon} \${cat.name}</span>
                \${p.featured ? '<span class="text-xs px-2 py-0.5 rounded-full font-medium text-white featured-badge">⭐ Destaque</span>' : ''}
                \${p.store ? \`<span class="text-xs text-gray-400 font-medium">\${p.store}</span>\` : ''}
              </div>
              <h3 class="font-bold text-gray-800 text-sm mt-1 line-clamp-1">\${p.title}</h3>
              <div class="flex items-center gap-3 mt-1">
                \${p.price ? \`<span class="text-sm font-black text-indigo-700">\${p.price}</span>\` : ''}
                <a href="\${p.productUrl}" target="_blank" class="text-xs text-indigo-500 hover:underline truncate max-w-xs">\${p.productUrl}</a>
              </div>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              <button onclick="toggleFeatured('\${p.categoryId}', '\${p.id}')" 
                class="p-2 rounded-xl border transition-all \${p.featured ? 'bg-yellow-50 border-yellow-200 text-yellow-500 hover:bg-yellow-100' : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-yellow-50 hover:border-yellow-200 hover:text-yellow-500'}"
                title="\${p.featured ? 'Remover destaque' : 'Marcar como destaque'}">
                <i class="fas fa-star text-sm"></i>
              </button>
              <a href="\${p.productUrl}" target="_blank" 
                class="p-2 rounded-xl border bg-indigo-50 border-indigo-200 text-indigo-500 hover:bg-indigo-100 transition-all"
                title="Abrir produto">
                <i class="fas fa-external-link-alt text-sm"></i>
              </a>
              <button onclick="deleteProduct('\${p.categoryId}', '\${p.id}', '\${p.title.replace(/'/g, "\\\\'")}')"
                class="p-2 rounded-xl border bg-red-50 border-red-200 text-red-400 hover:bg-red-100 transition-all"
                title="Remover produto">
                <i class="fas fa-trash text-sm"></i>
              </button>
            </div>
          </div>
        \`
      }).join('')
    }

    async function init() {
      const res = await fetch('/api/categories')
      categories = await res.json()
      
      const catSelect = document.getElementById('categoryId')
      const filterSelect = document.getElementById('filterCategory')
      
      categories.forEach(cat => {
        catSelect.innerHTML += \`<option value="\${cat.id}">\${cat.icon} \${cat.name}</option>\`
        filterSelect.innerHTML += \`<option value="\${cat.id}">\${cat.icon} \${cat.name}</option>\`
      })
      
      await loadProducts()
    }

    init()
  </script>
</body>
</html>`
}

export default app
