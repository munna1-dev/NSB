import type { VercelRequest, VercelResponse } from '@vercel/node'
import bcrypt from 'bcryptjs'
import { getDb } from '../../../db/client.js'
import { requirePermission } from '../../../auth/management.js'
import { writeStaffAuditLog } from '../../../auth/audit.js'

function json(response: VercelResponse, status: number, body: unknown) {
  return response.status(status).json(body)
}

function error(response: VercelResponse, status: number, message: string) {
  return json(response, status, { error: message })
}

function isSuperManager(role: string) {
  return role === 'super_manager'
}

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (!['GET', 'PATCH', 'POST'].includes(request.method ?? '')) {
    response.setHeader('Allow', 'GET, PATCH, POST')
    return error(response, 405, 'Method not allowed.')
  }

  const user = await requirePermission(request, 'staff.view')

  if (!user) {
    return error(response, 403, 'You do not have permission to access staff controls.')
  }

  if (!isSuperManager(user.role)) {
    return error(response, 403, 'Super Manager authorization is required.')
  }

  const db = getDb()

  try {
    if (request.method === 'GET') {
      const section =
        typeof request.query.section === 'string'
          ? request.query.section
          : 'staff'

      if (section === 'applications') {
        const result = await db.query(`
          SELECT
            id,
            customer_id,
            first_name,
            last_name,
            email,
            phone,
            employee_number,
            requested_department,
            requested_role,
            status,
            application_notes,
            review_notes,
            reviewed_by,
            reviewed_at,
            created_at,
            updated_at
          FROM staff_applications
          ORDER BY created_at DESC
          LIMIT 200
        `)

        return json(response, 200, {
          applications: result.rows,
        })
      }

      if (section === 'roles') {
        const result = await db.query(`
          SELECT
            r.id,
            r.role_key,
            r.role_name,
            r.description,
            r.is_system_role,
            r.is_active,
            r.created_at,
            r.updated_at,
            COUNT(DISTINCT sra.staff_id)::int AS staff_count
          FROM management_roles r
          LEFT JOIN staff_role_assignments_v2 sra
            ON sra.role_id = r.id
          GROUP BY
            r.id,
            r.role_key,
            r.role_name,
            r.description,
            r.is_system_role,
            r.is_active,
            r.created_at,
            r.updated_at
          ORDER BY r.role_name
        `)

        return json(response, 200, {
          roles: result.rows,
        })
      }

      if (section === 'permissions') {
        const result = await db.query(`
          SELECT
            id,
            permission_key,
            permission_name,
            permission_group,
            description,
            created_at
          FROM management_permissions
          ORDER BY permission_group, permission_name
        `)

        return json(response, 200, {
          permissions: result.rows,
        })
      }

      const result = await db.query(`
        SELECT
          s.id,
          s.staff_number,
          s.first_name,
          s.last_name,
          s.email,
          s.phone,
          s.status,
          COALESCE(
            (
              SELECT mr.role_key
              FROM staff_role_assignments_v2 sr2
              JOIN management_roles mr
                ON mr.id = sr2.role_id
              WHERE sr2.staff_id = s.id
                AND mr.is_active = TRUE
              ORDER BY sr2.assigned_at DESC
              LIMIT 1
            ),
            'staff'
          ) AS role,
          s.employee_number,
          s.department,
          s.approved_by,
          s.approved_at,
          s.blocked_by,
          s.blocked_at,
          s.block_reason,
          s.created_at,
          s.updated_at,
          COALESCE(
            json_agg(
              DISTINCT jsonb_build_object(
                'id', r.id,
                'roleKey', r.role_key,
                'roleName', r.role_name
              )
            ) FILTER (WHERE r.id IS NOT NULL),
            '[]'::json
          ) AS roles
        FROM staff s
        LEFT JOIN staff_role_assignments_v2 sra
          ON sra.staff_id = s.id
        LEFT JOIN management_roles r
          ON r.id = sra.role_id
        GROUP BY s.id
        ORDER BY s.created_at DESC
        LIMIT 500
      `)

      return json(response, 200, {
        staff: result.rows,
      })
    }

    if (request.method === 'POST') {
      const action =
        typeof request.body?.action === 'string'
          ? request.body.action.trim()
          : ''

      if (action === 'create-staff') {
        const firstName = typeof request.body?.first_name === 'string'
          ? request.body.first_name.trim() : ''
        const lastName = typeof request.body?.last_name === 'string'
          ? request.body.last_name.trim() : ''
        const email = typeof request.body?.email === 'string'
          ? request.body.email.trim().toLowerCase() : ''
        const phone = typeof request.body?.phone === 'string'
          ? request.body.phone.trim() : ''
        const employeeNumber = typeof request.body?.employee_number === 'string'
          ? request.body.employee_number.trim() : ''
        const department = typeof request.body?.department === 'string'
          ? request.body.department.trim() : ''
        const password = typeof request.body?.password === 'string'
          ? request.body.password : ''
        const roleKey = typeof request.body?.roleKey === 'string'
          ? request.body.roleKey.trim() : ''

        if (!firstName || !lastName || !email || !password || !roleKey) {
          return error(response, 400, 'First name, last name, staff email, initial password, and role are required.')
        }
        if (firstName.length > 100 || lastName.length > 100 ||
            email.length > 254 || phone.length > 40 ||
            employeeNumber.length > 80 || department.length > 120) {
          return error(response, 400, 'One or more staff fields exceed the permitted length.')
        }
        if (!/^[^\s@]+@northstarbank\.site$/i.test(email)) {
          return error(response, 400, 'Staff email must use the @northstarbank.site domain.')
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return error(response, 400, 'Enter a valid email address.')
        }
        if (password.length < 12 || password.length > 128) {
          return error(response, 400, 'The initial password must be between 12 and 128 characters.')
        }
        if (roleKey === 'super_manager') {
          return error(response, 400, 'A Super Manager account cannot be created through this form.')
        }

        const client = await db.connect()
        try {
          await client.query('BEGIN')

          const roleResult = await client.query(
            `SELECT id, role_key, role_name, is_active
             FROM management_roles WHERE role_key = $1 LIMIT 1`,
            [roleKey],
          )
          if (roleResult.rowCount !== 1 || !roleResult.rows[0].is_active) {
            await client.query('ROLLBACK')
            return error(response, 400, 'Choose an active management role.')
          }

          const dashboardPermission = await client.query(
            `SELECT id FROM management_permissions
             WHERE permission_key = 'dashboard.view' LIMIT 1`,
          )
          if (dashboardPermission.rowCount !== 1) {
            await client.query('ROLLBACK')
            return error(response, 500, 'Dashboard permission is not configured. Contact the system administrator.')
          }

          const duplicate = await client.query(
            `SELECT id FROM staff
             WHERE LOWER(email) = LOWER($1)
                OR ($2 <> '' AND employee_number = $2)
             LIMIT 1`,
            [email, employeeNumber],
          )
          if (duplicate.rowCount) {
            await client.query('ROLLBACK')
            return error(response, 409, 'That staff email or employee number is already in use.')
          }

          const passwordHash = await bcrypt.hash(password, 12)
          const inserted = await client.query(
            `INSERT INTO staff (
               staff_number, first_name, last_name, email, phone,
               password_hash, status, employee_number, department,
               approved_by, approved_at
             )
             VALUES (
               'STF-' || LPAD(nextval('staff_id_sequence')::text, 6, '0'),
               $1, $2, $3, NULLIF($4, ''), $5, 'active',
               NULLIF($6, ''), NULLIF($7, ''), $8, CURRENT_TIMESTAMP
             )
             RETURNING id, staff_number, first_name, last_name, email,
                       phone, status, employee_number, department, created_at`,
            [
              firstName, lastName, email, phone, passwordHash,
              employeeNumber, department, user.id,
            ],
          )
          const created = inserted.rows[0]

          await client.query(
            `INSERT INTO staff_role_assignments_v2
               (staff_id, role_id, assigned_by)
             VALUES ($1, $2, $3)`,
            [created.id, roleResult.rows[0].id, user.id],
          )

          await client.query(
            `INSERT INTO staff_permission_assignments_v2
               (staff_id, permission_id, effect, assigned_by)
             VALUES ($1, $2, 'allow', $3)
             ON CONFLICT (staff_id, permission_id)
             DO UPDATE SET
               effect = 'allow',
               assigned_by = EXCLUDED.assigned_by,
               assigned_at = CURRENT_TIMESTAMP`,
            [created.id, dashboardPermission.rows[0].id, user.id],
          )

          await client.query('COMMIT')

          try {
            await writeStaffAuditLog(
              request, user.id, 'staff.created', 'staff', created.id,
              'Staff account created by a Super Manager.',
              { staffNumber: created.staff_number, roleKey, email: created.email },
            )
          } catch (auditError) {
            console.error('Staff creation audit event failed:', auditError)
          }

          return json(response, 201, {
            success: true,
            staff: { ...created, role: roleKey, roles: [{
              id: roleResult.rows[0].id,
              roleKey: roleResult.rows[0].role_key,
              roleName: roleResult.rows[0].role_name,
            }] },
          })
        } catch (err) {
          try { await client.query('ROLLBACK') } catch (rollbackError) { console.error('Staff creation rollback failed:', rollbackError) }
          const code = (err as { code?: string })?.code
          if (code === '23505') {
            return error(response, 409, 'That staff email, employee number, or staff number is already in use.')
          }
          throw err
        } finally {
          client.release()
        }
      }

      if (action !== 'assign-role' && action !== 'assign-permission') {
        return error(response, 400, 'Unsupported staff action.')
      }

      const staffId =
        typeof request.body?.staffId === 'string'
          ? request.body.staffId.trim()
          : ''

      if (!staffId) {
        return error(response, 400, 'staffId is required.')
      }

      if (staffId === user.id) {
        return error(
          response,
          400,
          'The Super Manager account cannot modify its own staff authorization.',
        )
      }

      const staffResult = await db.query(
        `
          SELECT id
          FROM staff
          WHERE id = $1
          LIMIT 1
        `,
        [staffId],
      )

      if (staffResult.rowCount !== 1) {
        return error(response, 404, 'Staff member not found.')
      }

      if (action === 'assign-role') {
        const roleKey =
          typeof request.body?.roleKey === 'string'
            ? request.body.roleKey.trim()
            : ''

        if (!roleKey) {
          return error(response, 400, 'roleKey is required.')
        }

        const roleResult = await db.query(
          `
            SELECT id, role_key, role_name, is_active
            FROM management_roles
            WHERE role_key = $1
            LIMIT 1
          `,
          [roleKey],
        )

        if (roleResult.rowCount !== 1) {
          return error(response, 404, 'Management role not found.')
        }

        if (!roleResult.rows[0].is_active) {
          return error(response, 400, 'The selected role is inactive.')
        }

        if (roleKey === 'super_manager') {
          return error(
            response,
            400,
            'The Super Manager role cannot be assigned through this endpoint.',
          )
        }

        await db.query(
          `
            INSERT INTO staff_role_assignments_v2 (
              staff_id,
              role_id,
              assigned_by
            )
            VALUES ($1, $2, $3)
            ON CONFLICT (staff_id, role_id)
            DO UPDATE SET
              assigned_by = EXCLUDED.assigned_by,
              assigned_at = CURRENT_TIMESTAMP
          `,
          [staffId, roleResult.rows[0].id, user.id],
        )

        return json(response, 200, {
          success: true,
          action,
          staffId,
          role: roleResult.rows[0],
        })
      }

      const permissionKey =
        typeof request.body?.permissionKey === 'string'
          ? request.body.permissionKey.trim()
          : ''

      const effect =
        typeof request.body?.effect === 'string'
          ? request.body.effect.trim()
          : ''

      if (!permissionKey || !['allow', 'deny'].includes(effect)) {
        return error(
          response,
          400,
          'permissionKey and effect (allow or deny) are required.',
        )
      }

      const permissionResult = await db.query(
        `
          SELECT
            id,
            permission_key,
            permission_name,
            permission_group
          FROM management_permissions
          WHERE permission_key = $1
          LIMIT 1
        `,
        [permissionKey],
      )

      if (permissionResult.rowCount !== 1) {
        return error(response, 404, 'Management permission not found.')
      }

      if (permissionKey === 'dashboard.view' && effect === 'deny') {
        return error(response, 400, 'Every staff account must retain access to its management dashboard.')
      }

      await db.query(
        `
          INSERT INTO staff_permission_assignments_v2 (
            staff_id,
            permission_id,
            effect,
            assigned_by
          )
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (staff_id, permission_id)
          DO UPDATE SET
            effect = EXCLUDED.effect,
            assigned_by = EXCLUDED.assigned_by,
            assigned_at = CURRENT_TIMESTAMP
        `,
        [
          staffId,
          permissionResult.rows[0].id,
          effect,
          user.id,
        ],
      )

      return json(response, 200, {
        success: true,
        action,
        staffId,
        permission: permissionResult.rows[0],
        effect,
      })
    }
    const action =
      typeof request.body?.action === 'string'
        ? request.body.action.trim()
        : ''

    if (action === 'approve-application' || action === 'reject-application') {
      const applicationId =
        typeof request.body?.applicationId === 'string'
          ? request.body.applicationId.trim()
          : ''

      const reviewNotes =
        typeof request.body?.reviewNotes === 'string'
          ? request.body.reviewNotes.trim()
          : ''

      if (!applicationId) {
        return error(response, 400, 'applicationId is required.')
      }

      if (action === 'reject-application' && reviewNotes.length < 3) {
        return error(
          response,
          400,
          'A review note is required when rejecting a staff application.',
        )
      }

      const client = await db.connect()

      try {
        await client.query('BEGIN')

        const applicationResult = await client.query(
          `
            SELECT
              id,
              customer_id,
              first_name,
              last_name,
              email,
              phone,
              employee_number,
              requested_department,
              requested_role,
              status
            FROM staff_applications
            WHERE id = $1
            FOR UPDATE
          `,
          [applicationId],
        )

        if (applicationResult.rowCount !== 1) {
          await client.query('ROLLBACK')
          return error(response, 404, 'Staff application not found.')
        }

        const application = applicationResult.rows[0]

        if (application.status !== 'pending') {
          await client.query('ROLLBACK')
          return error(
            response,
            409,
            `This staff application is already ${application.status}.`,
          )
        }

        if (action === 'reject-application') {
          await client.query(
            `
              UPDATE staff_applications
              SET
                status = 'rejected',
                review_notes = $1,
                reviewed_by = $2,
                reviewed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
              WHERE id = $3
            `,
            [reviewNotes, user.id, applicationId],
          )

          await client.query('COMMIT')

          await writeStaffAuditLog(
            request,
            user.id,
            'staff_application.rejected',
            'staff_application',
            applicationId,
            'Staff application rejected by Super Manager.',
            {
              applicationId,
              reviewNotes,
            },
          )

          return json(response, 200, {
            success: true,
            action,
            applicationId,
            status: 'rejected',
          })
        }

        if (!application.customer_id) {
          await client.query('ROLLBACK')
          return error(
            response,
            409,
            'This staff application is not linked to an existing customer account.',
          )
        }

        const applicationEmail =
          typeof application.email === 'string'
            ? application.email.trim().toLowerCase()
            : '';

        const linkedCustomer = await client.query(
          'SELECT email FROM customers WHERE id = $1 LIMIT 1',
          [application.customer_id],
        );

        const customerEmail =
          typeof linkedCustomer.rows[0]?.email === 'string'
            ? linkedCustomer.rows[0].email.trim().toLowerCase()
            : '';

        if (
          !applicationEmail.endsWith('@northstarbank.site') ||
          linkedCustomer.rowCount !== 1 ||
          !customerEmail.endsWith('@northstarbank.site') ||
          customerEmail !== applicationEmail
        ) {
          await client.query('ROLLBACK');
          return error(
            response,
            400,
            'Staff application and linked customer must use the same @northstarbank.site email address.',
          );
        }

        const requestedRole =
          typeof application.requested_role === 'string'
            ? application.requested_role.trim()
            : ''

        if (!requestedRole) {
          await client.query('ROLLBACK')
          return error(
            response,
            409,
            'The staff application does not specify a requested role.',
          )
        }

        if (requestedRole === 'super_manager') {
          await client.query('ROLLBACK')
          return error(
            response,
            400,
            'A staff application cannot grant the Super Manager role.',
          )
        }

        const roleResult = await client.query(
          `
            SELECT id, role_key, role_name, is_active
            FROM management_roles
            WHERE role_key = $1
            LIMIT 1
          `,
          [requestedRole],
        )

        if (roleResult.rowCount !== 1) {
          await client.query('ROLLBACK')
          return error(response, 404, 'Requested management role not found.')
        }

        if (!roleResult.rows[0].is_active) {
          await client.query('ROLLBACK')
          return error(response, 400, 'Requested management role is inactive.')
        }

        const employeeNumber =
          typeof application.employee_number === 'string'
            ? application.employee_number.trim() || null
            : null

        if (employeeNumber) {
          const employeeResult = await client.query(
            `
              SELECT id
              FROM staff
              WHERE employee_number = $1
              LIMIT 1
            `,
            [employeeNumber],
          )

          if (employeeResult.rowCount !== 0) {
            await client.query('ROLLBACK')
            return error(response, 409, 'Employee number is already assigned.')
          }
        }

        const staffInsert = await client.query(
          `
            INSERT INTO staff (
              staff_number,
              first_name,
              last_name,
              email,
              phone,
              password_hash,
              status,
              employee_number,
              department,
              approved_by,
              approved_at
            )
            SELECT
              'STF-' || LPAD(nextval('staff_id_sequence')::text, 6, '0'),
              first_name,
              last_name,
              email,
              phone,
              password_hash,
              'active',
              $1,
              $2,
              $3,
              CURRENT_TIMESTAMP
            FROM customers
            WHERE id = $4
            RETURNING id, staff_number
          `,
          [
            employeeNumber,
            application.requested_department ?? null,
            user.id,
            application.customer_id,
          ],
        )

        if (staffInsert.rowCount !== 1) {
          await client.query('ROLLBACK')
          return error(response, 409, 'Unable to create the staff account.')
        }

        const staffId = staffInsert.rows[0].id as string
        const staffNumber = staffInsert.rows[0].staff_number as string

        await client.query(
          `
            INSERT INTO staff_role_assignments_v2 (
              staff_id,
              role_id,
              assigned_by
            )
            VALUES ($1, $2, $3)
            ON CONFLICT (staff_id, role_id)
            DO UPDATE SET
              assigned_by = EXCLUDED.assigned_by,
              assigned_at = CURRENT_TIMESTAMP
          `,
          [
            staffId,
            roleResult.rows[0].id,
            user.id,
          ],
        )

        await client.query(
          `
            UPDATE staff_applications
            SET
              status = 'approved',
              review_notes = $1,
              reviewed_by = $2,
              reviewed_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
          `,
          [
            reviewNotes || null,
            user.id,
            applicationId,
          ],
        )

        await client.query('COMMIT')

        await writeStaffAuditLog(
          request,
          user.id,
          'staff_application.approved',
          'staff_application',
          applicationId,
          'Staff application approved by Super Manager.',
          {
            applicationId,
            customerId: application.customer_id,
            staffId,
            role: requestedRole,
            department: application.requested_department ?? null,
            employeeNumber,
          },
        )

        return json(response, 200, {
          success: true,
          action,
          applicationId,
          status: 'approved',
          customerId: application.customer_id,
          staffId,
          staffNumber,
          role: roleResult.rows[0],
          employeeNumber,
          department: application.requested_department ?? null,
        })
      } catch (cause) {
        await client.query('ROLLBACK')
        throw cause
      } finally {
        client.release()
      }
    }
    const staffId =
      typeof request.body?.staffId === 'string'
        ? request.body.staffId.trim()
        : ''

    if (!staffId || !action) {
      return error(response, 400, 'staffId and action are required.')
    }

    if (staffId === user.id) {
      return error(
        response,
        400,
        'The Super Manager account cannot modify its own staff status.',
      )
    }

    if (action === 'edit-profile') {
      const firstName =
        typeof request.body?.first_name === 'string'
          ? request.body.first_name.trim()
          : ''
      const lastName =
        typeof request.body?.last_name === 'string'
          ? request.body.last_name.trim()
          : ''
      const phoneInput = request.body?.phone
      const phone =
        typeof phoneInput === 'string' ? phoneInput.trim() : ''
      const employeeInput = request.body?.employee_number
      const employeeNumber =
        typeof employeeInput === 'string' ? employeeInput.trim() : ''
      const departmentInput = request.body?.department
      const department =
        typeof departmentInput === 'string' ? departmentInput.trim() : ''

      if (!firstName || !lastName) {
        return error(response, 400, 'First name and last name are required.')
      }
      if (firstName.length > 80 || lastName.length > 80) {
        return error(response, 400, 'Names must be 80 characters or fewer.')
      }
      if (phone.length > 40 || employeeNumber.length > 64 || department.length > 120) {
        return error(response, 400, 'Phone, employee number, or department exceeds its allowed length.')
      }

      const existingStaff = await db.query(
        'SELECT id FROM staff WHERE id = $1 LIMIT 1',
        [staffId],
      )
      if (existingStaff.rowCount !== 1) {
        return error(response, 404, 'Staff member not found.')
      }

      if (employeeNumber) {
        const duplicate = await db.query(
          `SELECT id FROM staff
           WHERE LOWER(employee_number) = LOWER($1) AND id <> $2
           LIMIT 1`,
          [employeeNumber, staffId],
        )
        if (duplicate.rowCount) {
          return error(response, 409, 'That employee number is already assigned.')
        }
      }

      const result = await db.query(
        `UPDATE staff
         SET first_name = $1,
             last_name = $2,
             phone = $3,
             employee_number = $4,
             department = $5,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $6 AND id <> $7
         RETURNING id, staff_number, first_name, last_name, email, phone,
                   status, employee_number, department, approved_by,
                   approved_at, blocked_by, blocked_at, block_reason, updated_at`,
        [
          firstName,
          lastName,
          phone || null,
          employeeNumber || null,
          department || null,
          staffId,
          user.id,
        ],
      )

      if (result.rowCount !== 1) {
        return error(response, 404, 'Staff member not found or cannot be edited.')
      }

      try {
        await writeStaffAuditLog(
          request,
          user.id,
          'staff.profile_updated',
          'staff',
          staffId,
          'Staff profile fields updated by Super Manager.',
          {
            changedFields: ['first_name', 'last_name', 'phone', 'employee_number', 'department'],
            staffNumber: result.rows[0].staff_number,
          },
        )
      } catch (auditError) {
        console.error('Staff profile audit logging failed:', auditError)
      }

      return json(response, 200, { success: true, staff: result.rows[0] })
    }

    const allowedActions = new Map<string, string>([
      ['activate', 'active'],
      ['suspend', 'suspended'],
      ['block', 'blocked'],
      ['reactivate', 'active'],
      ['terminate', 'terminated'],
    ])

    const nextStatus = allowedActions.get(action)

    if (!nextStatus) {
      return error(response, 400, 'Unsupported staff status action.')
    }

    const result = await db.query(
      `
        UPDATE staff
        SET
          status = $1,
          blocked_by = CASE
            WHEN $1 = 'blocked' THEN $2
            ELSE blocked_by
          END,
          blocked_at = CASE
            WHEN $1 = 'blocked' THEN CURRENT_TIMESTAMP
            ELSE blocked_at
          END,
          block_reason = CASE
            WHEN $1 = 'blocked' THEN COALESCE($3, block_reason)
            ELSE block_reason
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = $4
          AND id <> $2
        RETURNING
          id,
          staff_number,
          first_name,
          last_name,
          email,
          phone,
          status,
          employee_number,
          department,
          approved_by,
          approved_at,
          blocked_by,
          blocked_at,
          block_reason,
          updated_at
      `,
      [
        nextStatus,
        user.id,
        typeof request.body?.reason === 'string'
          ? request.body.reason.trim() || null
          : null,
        staffId,
      ],
    )

    if (result.rowCount !== 1) {
      return error(response, 404, 'Staff member not found.')
    }

    try {
      await writeStaffAuditLog(
        request,
        user.id,
        `staff.${action}`,
        'staff',
        staffId,
        `Staff status changed to ${nextStatus}.`,
        {
          previousAction: action,
          newStatus: nextStatus,
          reason:
            typeof request.body?.reason === 'string'
              ? request.body.reason.trim().slice(0, 500) || null
              : null,
        },
      )
    } catch (auditError) {
      // Do not report the successful status update as failed if audit
      // logging encounters a separate operational error.
      console.error('Staff lifecycle audit logging failed:', auditError)
    }

    return json(response, 200, {
      success: true,
      action,
      staff: result.rows[0],
    })
  } catch (cause) {
    console.error('Management staff API error:', cause)
    return error(response, 500, 'Unable to complete the staff operation.')
  }
}
