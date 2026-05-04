import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'

const app = express()
const PORT = process.env.PORT || 3001
const STORAGE_BUCKET = process.env.SUPABASE_IMAGE_BUCKET || 'project-photos'
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://udctpettghspevhumvvq.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkY3RwZXR0Z2hzcGV2aHVtdnZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA1MzAzODEsImV4cCI6MjA4NjEwNjM4MX0.LBLhDEFt-NaPt1qsXU_nG770D2nVDG72VRNEm9OqBYE'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function saveImageToStorage(imageBase64, projectId) {
  const filename = `project_${projectId}_${Date.now()}.jpg`
  const buffer = Buffer.from(imageBase64, 'base64')

  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(filename, buffer, { upsert: true })

  if (uploadError) {
    throw uploadError
  }

  const { data: publicUrlData, error: publicUrlError } = supabase.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(filename)

  if (publicUrlError) {
    throw publicUrlError
  }

  return publicUrlData.publicUrl
}

app.use(cors())
app.use(express.json({ limit: '10mb' }))
app.use('/uploads', express.static('uploads'))

// Get all projects
app.get('/api/projects', async (req, res) => {
  const { page = 1, limit = 50, sector, state, search, status, mda } = req.query
  
  let query = supabase
    .from('projects')
    .select('id, title, description, project_type, status, sector, ministry, contractor, budget, disbursed, verified_progress, state_name, lga, area, latitude, longitude, start_date, expected_end_date, year, project_code', { count: 'exact' })
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)
    .order('budget', { ascending: false })
  
  // Only apply range if limit is reasonable
  if (limit < 10000) {
    query = query.range((page - 1) * limit, page * limit - 1)
  }
  
  if (sector) query = query.eq('sector', sector)
  if (state) query = query.eq('state_name', state)
  if (status) query = query.eq('status', status)
  if (mda) query = query.eq('mda_code', mda)
  if (search) query = query.ilike('title', `%${search}%`)
  
  const { data, error, count } = await query
  
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: count, page: +page, limit: +limit })
})

// Get featured projects
app.get('/api/projects/featured', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .not('latitude', 'is', null)
    .not('longitude', 'is', null)
    .order('budget', { ascending: false })
    .limit(6)
  
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Get nearby projects by lat/lng and radius (km)
app.get('/api/projects/nearby', async (req, res) => {
  const { lat, lng, radiusKm = 10, page = 1, limit = 1000 } = req.query

  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng query parameters required' })

  const latitude = parseFloat(lat)
  const longitude = parseFloat(lng)
  const radius = parseFloat(radiusKm)

  // rough bounding box optimization
  const latDelta = radius / 111 // ~111 km per degree latitude
  const lngDelta = Math.abs(radius / (111 * Math.cos((latitude * Math.PI) / 180))) || 180

  try {
    const { data, error, count } = await supabase
      .from('projects')
      .select('id, title, latitude, longitude, status, project_type, sector, budget, state_name, year', { count: 'exact' })
      .not('latitude', 'is', null)
      .not('longitude', 'is', null)
      .gte('latitude', latitude - latDelta)
      .lte('latitude', latitude + latDelta)
      .gte('longitude', longitude - lngDelta)
      .lte('longitude', longitude + lngDelta)
      .order('budget', { ascending: false })
      .range((page - 1) * limit, page * limit - 1)

    if (error) return res.status(500).json({ error: error.message })

    // Haversine distance filter in JS
    function haversineKm(lat1, lon1, lat2, lon2) {
      const R = 6371
      const dLat = ((lat2 - lat1) * Math.PI) / 180
      const dLon = ((lon2 - lon1) * Math.PI) / 180
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
      return R * c
    }

    const filtered = (data || [])
      .filter(p => p.latitude && p.longitude && haversineKm(latitude, longitude, p.latitude, p.longitude) <= radius)
      .map(p => ({ ...p, distance_km: Math.round(haversineKm(latitude, longitude, p.latitude, p.longitude) * 10) / 10 }))
      .sort((a, b) => a.distance_km - b.distance_km)

    res.json({ data: filtered, totalCandidates: count || 0, page: +page, limit: +limit })
  } catch (e) {
    console.error('Nearby error', e)
    res.status(500).json({ error: 'Server error' })
  }
})

// Get project by ID
app.get('/api/projects/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', req.params.id)
    .single()
  
  if (error) return res.status(404).json({ error: 'Project not found' })
  res.json(data)
})

// Update project location
app.patch('/api/projects/:id/location', async (req, res) => {
  const { latitude, longitude, image } = req.body
  const latitudeNum = parseFloat(latitude)
  const longitudeNum = parseFloat(longitude)

  if (Number.isNaN(latitudeNum) || Number.isNaN(longitudeNum)) {
    return res.status(400).json({ error: 'Latitude and longitude required' })
  }

  console.log('Updating project:', req.params.id, 'with lat:', latitudeNum, 'lng:', longitudeNum)

  const { data: existing, error: checkError } = await supabase
    .from('projects')
    .select('id, title, latitude, longitude')
    .eq('id', req.params.id)
    .single()

  if (checkError || !existing) {
    console.log('Project not found:', checkError)
    return res.status(404).json({ error: 'Project not found' })
  }

  console.log('Before update:', existing)

  const updateData = {
    latitude: latitudeNum,
    longitude: longitudeNum,
    updated_at: new Date().toISOString()
  }

  if (image) {
    try {
      const publicUrl = await saveImageToStorage(image, req.params.id)
      updateData.image_url = publicUrl
      console.log('Image saved to storage:', publicUrl)
    } catch (e) {
      console.log('Error saving image to storage:', e)
      return res.status(500).json({ error: 'Failed to save project image', details: e?.message || String(e) })
    }
  }

  const { error: updateError } = await supabase
    .from('projects')
    .update(updateData)
    .eq('id', req.params.id)

  if (updateError) {
    console.log('Update error:', updateError)
    return res.status(500).json({ error: updateError.message })
  }

  const { data: updated, error: fetchError } = await supabase
    .from('projects')
    .select('id, title, latitude, longitude, image_url')
    .eq('id', req.params.id)
    .single()

  if (fetchError) {
    console.log('Error fetching updated project:', fetchError)
    return res.status(500).json({ error: 'Failed to fetch updated project', details: fetchError.message })
  }

  console.log('After update:', updated)

  res.json({ success: true, id: req.params.id, data: updated })
})

// Get project reports
app.get('/api/projects/:id/reports', async (req, res) => {
  const { data, error } = await supabase
    .from('project_reports')
    .select('*')
    .eq('project_id', req.params.id)
    .order('created_at', { ascending: false })
  
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Get project evidence
app.get('/api/projects/:id/evidence', async (req, res) => {
  const { data, error } = await supabase
    .from('evidence_items')
    .select('*')
    .eq('project_id', req.params.id)
    .order('created_at', { ascending: false })
  
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Create project report
app.post('/api/projects/:id/reports', async (req, res) => {
  const { data, error } = await supabase
    .from('project_reports')
    .insert({ ...req.body, project_id: req.params.id })
    .select()
    .single()
  
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Create evidence item
app.post('/api/projects/:id/evidence', async (req, res) => {
  const { data, error } = await supabase
    .from('evidence_items')
    .insert({ ...req.body, project_id: req.params.id })
    .select()
    .single()
  
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Get all states
app.get('/api/states', async (req, res) => {
  const { data, error } = await supabase
    .from('nigerian_states')
    .select('*')
    .order('name')
  
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Get state by code
app.get('/api/states/:code', async (req, res) => {
  const { data, error } = await supabase
    .from('nigerian_states')
    .select('*')
    .eq('code', req.params.code)
    .single()
  
  if (error) return res.status(404).json({ error: 'State not found' })
  res.json(data)
})

// Get state projects
app.get('/api/states/:code/projects', async (req, res) => {
  const { page = 1, limit = 50 } = req.query
  
  const { data, error, count } = await supabase
    .from('projects')
    .select('*', { count: 'exact' })
    .eq('state_name', req.params.code)
    .order('budget', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)
  
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: count, page: +page, limit: +limit })
})

// Get state statistics
app.get('/api/states/:code/stats', async (req, res) => {
  const { data: projects } = await supabase
    .from('projects')
    .select('budget')
    .eq('state_name', req.params.code)
  
  const totalBudget = projects?.reduce((sum, p) => sum + (p.budget || 0), 0) || 0
  
  res.json({
    totalProjects: projects?.length || 0,
    totalBudget
  })
})

// Get all sectors
app.get('/api/sectors', async (req, res) => {
  const { data, error } = await supabase
    .from('sectors')
    .select('*')
    .order('name')
  
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Get sector by slug
app.get('/api/sectors/:slug', async (req, res) => {
  const { data, error } = await supabase
    .from('sectors')
    .select('*')
    .eq('slug', req.params.slug)
    .single()
  
  if (error) return res.status(404).json({ error: 'Sector not found' })
  res.json(data)
})

// Get sector projects
app.get('/api/sectors/:slug/projects', async (req, res) => {
  const { page = 1, limit = 50 } = req.query
  
  const { data, error, count } = await supabase
    .from('projects')
    .select('*', { count: 'exact' })
    .eq('sector', req.params.slug)
    .order('budget', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)
  
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: count, page: +page, limit: +limit })
})

// Get sector statistics
app.get('/api/sectors/:slug/stats', async (req, res) => {
  const { data: projects } = await supabase
    .from('projects')
    .select('budget')
    .eq('sector', req.params.slug)
  
  const totalBudget = projects?.reduce((sum, p) => sum + (p.budget || 0), 0) || 0
  
  res.json({
    totalProjects: projects?.length || 0,
    totalBudget
  })
})

// Get budget statistics
app.get('/api/stats', async (req, res) => {
  const { data: projects } = await supabase.from('projects').select('budget')
  const { data: states } = await supabase.from('nigerian_states').select('code', { count: 'exact' })
  const { data: sectors } = await supabase.from('sectors').select('slug', { count: 'exact' })
  
  const totalBudget = projects?.reduce((sum, p) => sum + (p.budget || 0), 0) || 0
  
  res.json({
    totalProjects: projects?.length || 0,
    totalBudget,
    totalStates: states?.length || 0,
    totalSectors: sectors?.length || 0
  })
})

// Get MDAs
app.get('/api/mdas', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('mda_code, mda_name')
    .not('mda_code', 'is', null)
    .order('mda_name')
  
  if (error) return res.status(500).json({ error: error.message })
  
  const unique = [...new Map(data.map(m => [m.mda_code, m])).values()]
  res.json(unique)
})

// Get MDA projects
app.get('/api/mdas/:code/projects', async (req, res) => {
  const { page = 1, limit = 50 } = req.query
  
  const { data, error, count } = await supabase
    .from('projects')
    .select('*', { count: 'exact' })
    .eq('mda_code', req.params.code)
    .order('budget', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)
  
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: count, page: +page, limit: +limit })
})

// Get community projects
app.get('/api/community-projects', async (req, res) => {
  const { page = 1, limit = 50, state, status } = req.query
  
  let query = supabase
    .from('community_projects')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1)
  
  if (state) query = query.eq('state', state)
  if (status) query = query.eq('status', status)
  
  const { data, error, count } = await query
  
  if (error) return res.status(500).json({ error: error.message })
  res.json({ data, total: count, page: +page, limit: +limit })
})

// Create community project
app.post('/api/community-projects', async (req, res) => {
  const { data, error } = await supabase
    .from('community_projects')
    .insert(req.body)
    .select()
    .single()
  
  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// Get analytics - budget by sector
app.get('/api/analytics/by-sector', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('sector, budget')
  
  if (error) return res.status(500).json({ error: error.message })
  
  const grouped = data.reduce((acc, p) => {
    if (!acc[p.sector]) acc[p.sector] = { sector: p.sector, totalBudget: 0, count: 0 }
    acc[p.sector].totalBudget += p.budget || 0
    acc[p.sector].count++
    return acc
  }, {})
  
  res.json(Object.values(grouped))
})

// Get analytics - budget by state
app.get('/api/analytics/by-state', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('state, budget')
  
  if (error) return res.status(500).json({ error: error.message })
  
  const grouped = data.reduce((acc, p) => {
    if (!acc[p.state]) acc[p.state] = { state: p.state, totalBudget: 0, count: 0 }
    acc[p.state].totalBudget += p.budget || 0
    acc[p.state].count++
    return acc
  }, {})
  
  res.json(Object.values(grouped))
})

// Get analytics - budget by MDA
app.get('/api/analytics/by-mda', async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('mda_code, mda_name, budget')
    .not('mda_code', 'is', null)
  
  if (error) return res.status(500).json({ error: error.message })
  
  const grouped = data.reduce((acc, p) => {
    if (!acc[p.mda_code]) acc[p.mda_code] = { mda_code: p.mda_code, mda_name: p.mda_name, totalBudget: 0, count: 0 }
    acc[p.mda_code].totalBudget += p.budget || 0
    acc[p.mda_code].count++
    return acc
  }, {})
  
  res.json(Object.values(grouped).sort((a, b) => b.totalBudget - a.totalBudget))
})

// Search across all entities
app.get('/api/search', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'Query parameter required' })
  
  const [projects, states, sectors] = await Promise.all([
    supabase.from('projects').select('id, title, budget, sector, state').ilike('title', `%${q}%`).limit(10),
    supabase.from('nigerian_states').select('*').ilike('name', `%${q}%`).limit(5),
    supabase.from('sectors').select('*').ilike('name', `%${q}%`).limit(5)
  ])
  
  res.json({
    projects: projects.data || [],
    states: states.data || [],
    sectors: sectors.data || []
  })
})

app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`))
